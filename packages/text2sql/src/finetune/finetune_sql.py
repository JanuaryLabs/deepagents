"""
Full supervised fine-tuning of Qwen3 0.6B on sql-create-context dataset.

Supports both Mac (MPS) and Linux/Windows (CUDA).

Usage:
    python finetune_sql.py [options]

Options:
    --epochs        Number of training epochs (default: 3)
    --batch-size    Per-device batch size (default: 2 on Mac, 4 on CUDA)
    --lr            Learning rate (default: 2e-5)
    --output-dir    Output directory for model (default: ./.finetune/qwen3-sql)
    --max-samples   Limit training samples (default: all)
    --use-hf        Use HuggingFace dataset instead of local JSON
    --no-gguf       Disable automatic GGUF conversion
    --gguf-type     GGUF quantization type (default: q8_0)

Prerequisites:
    Docker  # Required for GGUF conversion (uses ghcr.io/ggml-org/llama.cpp:full)
"""

import argparse
import json
import os
import platform
import subprocess
import sys
import threading
import warnings
from pathlib import Path

import torch
from datasets import Dataset, load_dataset
from trl import SFTConfig, SFTTrainer

# Suppress false-positive warnings
# The Mistral regex warning is incorrectly triggered for Qwen3 tokenizers
warnings.filterwarnings("ignore", message=".*incorrect regex pattern.*")
# The PAD/BOS/EOS alignment message is informational, not an issue
warnings.filterwarnings("ignore", message=".*The tokenizer has new PAD/BOS/EOS tokens.*")


DOCKER_IMAGE = "ghcr.io/ggml-org/llama.cpp:full"
CONVERT_SCRIPT_URL = "https://raw.githubusercontent.com/ggml-org/llama.cpp/master/convert_hf_to_gguf.py"


def get_convert_script() -> Path:
    """Download convert_hf_to_gguf.py from llama.cpp if not cached."""
    cache_dir = Path(__file__).parent / ".cache"
    cache_dir.mkdir(exist_ok=True)
    script_path = cache_dir / "convert_hf_to_gguf.py"

    if not script_path.exists():
        import urllib.request
        print(f"Downloading conversion script from {CONVERT_SCRIPT_URL}...")
        urllib.request.urlretrieve(CONVERT_SCRIPT_URL, script_path)

    return script_path


def _run_with_filtered_stderr(cmd: list, env: dict) -> None:
    """Run subprocess and filter out known false-positive warnings from stderr."""
    # Patterns to filter from stderr (these are false-positive warnings)
    filter_patterns = [
        "incorrect regex pattern",  # Qwen3 tokenizer falsely triggers Mistral warning
        "huggingface/tokenizers: The current process just got forked",  # Parallelism warning
        "To disable this warning",  # Continuation of parallelism warning
        "Avoid using `tokenizers` before the fork",  # Continuation
        "Explicitly set the environment variable TOKENIZERS_PARALLELISM",  # Continuation
    ]

    proc = subprocess.Popen(
        cmd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    # Stream stdout directly
    def stream_stdout():
        for line in proc.stdout:
            print(line, end="")

    stdout_thread = threading.Thread(target=stream_stdout)
    stdout_thread.start()

    # Filter stderr
    for line in proc.stderr:
        if not any(pattern in line for pattern in filter_patterns):
            print(line, end="", file=sys.stderr)

    stdout_thread.join()
    proc.wait()

    if proc.returncode != 0:
        raise subprocess.CalledProcessError(proc.returncode, cmd)


def convert_to_gguf(model_path: str, output_path: str, quantization: str = "q8_0") -> str:
    """Convert HuggingFace model to GGUF format."""
    model_path = os.path.abspath(model_path)
    output_path = os.path.abspath(output_path)

    # Ensure output directory exists
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # Environment for subprocess to suppress warnings
    env = os.environ.copy()
    env["TOKENIZERS_PARALLELISM"] = "false"
    env["TRANSFORMERS_VERBOSITY"] = "error"  # Suppress info/warning logs
    env["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"
    env["PYTHONWARNINGS"] = "ignore"  # Suppress Python warnings in subprocess

    # Try Docker first (works on Linux x86_64)
    is_arm = platform.machine() in ("arm64", "aarch64")
    docker_available = subprocess.run(
        ["docker", "--version"], capture_output=True
    ).returncode == 0

    if docker_available and not is_arm:
        # Use Docker on x86_64 Linux
        output_dir = os.path.dirname(output_path)
        output_name = os.path.basename(output_path)
        cmd = [
            "docker", "run", "--rm",
            "-e", "TOKENIZERS_PARALLELISM=false",
            "-e", "TRANSFORMERS_VERBOSITY=error",
            "-v", f"{model_path}:/model:ro",
            "-v", f"{output_dir}:/output",
            DOCKER_IMAGE,
            "python3", "/app/convert_hf_to_gguf.py",
            "/model",
            "--outfile", f"/output/{output_name}",
            "--outtype", quantization
        ]
        print(f"Using Docker image: {DOCKER_IMAGE}")
        _run_with_filtered_stderr(cmd, env)
    else:
        # Use downloaded script (works on ARM64 Mac and systems without Docker)
        script_path = get_convert_script()
        print(f"Using local conversion script: {script_path}")

        # Get the Python from current venv
        venv_python = Path(__file__).parent / ".venv" / "bin" / "python"
        python_cmd = str(venv_python) if venv_python.exists() else "python3"

        cmd = [
            python_cmd,
            "-W", "ignore::UserWarning",  # Suppress UserWarnings
            str(script_path),
            model_path,
            "--outfile", output_path,
            "--outtype", quantization
        ]
        _run_with_filtered_stderr(cmd, env)

    return output_path


def get_device_info() -> dict:
    """Detect available hardware and return appropriate settings."""
    is_mac = platform.system() == "Darwin"
    has_mps = is_mac and torch.backends.mps.is_available()
    has_cuda = torch.cuda.is_available()

    if has_mps:
        return {
            "device": "mps",
            "bf16": False,  # MPS doesn't support bf16
            "fp16": False,  # fp16 can be unstable on MPS
            "default_batch_size": 2,
            "gradient_checkpointing": True,
        }
    elif has_cuda:
        return {
            "device": "cuda",
            "bf16": True,
            "fp16": False,
            "default_batch_size": 4,
            "gradient_checkpointing": False,
        }
    else:
        return {
            "device": "cpu",
            "bf16": False,
            "fp16": False,
            "default_batch_size": 1,
            "gradient_checkpointing": True,
        }


def load_jsonl_dataset(path: str, max_samples: int | None = None) -> Dataset:
    """Load JSONL file with chat messages format."""
    with open(path) as f:
        data = [json.loads(line) for line in f if line.strip()]
    if max_samples:
        data = data[:max_samples]
    return Dataset.from_list(data)


def load_local_dataset(json_path: str, max_samples: int | None = None) -> Dataset:
    """Load sql-create-context from local JSON file."""
    with open(json_path) as f:
        data = json.load(f)

    rows = data["rows"]
    if max_samples:
        rows = rows[:max_samples]

    return Dataset.from_list([row["row"] for row in rows])


def load_hf_dataset(max_samples: int | None = None) -> Dataset:
    """Load sql-create-context from HuggingFace."""
    dataset = load_dataset("b-mc2/sql-create-context", split="train")
    if max_samples:
        dataset = dataset.select(range(min(max_samples, len(dataset))))
    return dataset


def format_for_sft(example: dict) -> dict:
    """Convert sql-create-context format to SFT prompt-completion format."""
    prompt = f"""Given the following SQL schema:
{example["context"]}

Write a SQL query to answer: {example["question"]}"""

    return {
        "prompt": [{"role": "user", "content": prompt}],
        "completion": [{"role": "assistant", "content": example["answer"]}]
    }


def main():
    # Get device-specific defaults
    device_info = get_device_info()

    parser = argparse.ArgumentParser(description="Fine-tune Qwen3 on SQL dataset")
    parser.add_argument("--epochs", type=int, default=3, help="Number of training epochs")
    parser.add_argument("--batch-size", type=int, default=device_info["default_batch_size"], help="Per-device batch size")
    parser.add_argument("--lr", type=float, default=2e-5, help="Learning rate")
    parser.add_argument("--output-dir", type=str, default="./.finetune/qwen3-sql", help="Output directory")
    parser.add_argument("--max-samples", type=int, default=None, help="Limit training samples")
    parser.add_argument("--input", type=str, default=None, help="Path to JSONL training file (chat messages format)")
    parser.add_argument("--use-hf", action="store_true", help="Use HuggingFace sql-create-context dataset")
    parser.add_argument("--model", type=str, default="Qwen/Qwen3-0.6B", help="Base model to fine-tune")
    parser.add_argument("--eval-split", type=float, default=0.1, help="Evaluation split ratio")
    parser.add_argument("--no-gguf", action="store_true", help="Disable automatic GGUF conversion")
    parser.add_argument("--gguf-type", type=str, default="q8_0", help="GGUF quantization type (f16, f32, q8_0, q4_0, etc.)")
    args = parser.parse_args()

    print("=" * 50)
    print("Full Supervised Fine-Tuning (SFT)")
    print("=" * 50)
    print()
    print(f"Device: {device_info['device']}")
    print(f"Model: {args.model}")
    print(f"Epochs: {args.epochs}")
    print(f"Batch size: {args.batch_size}")
    print(f"Learning rate: {args.lr}")
    print(f"Output: {args.output_dir}")
    print(f"Max samples: {args.max_samples or 'all'}")
    print(f"bf16: {device_info['bf16']}")
    print(f"Gradient checkpointing: {device_info['gradient_checkpointing']}")
    print()

    # Load dataset
    if args.input:
        print(f"Loading dataset from {args.input}...")
        dataset = load_jsonl_dataset(args.input, args.max_samples)
        print(f"Loaded {len(dataset)} examples")
        # JSONL is already in messages format, no reformatting needed
    elif args.use_hf:
        print("Loading dataset from HuggingFace...")
        dataset = load_hf_dataset(args.max_samples)
        print(f"Loaded {len(dataset)} examples")
        # Format for SFT
        print("Formatting dataset for SFT...")
        dataset = dataset.map(
            format_for_sft,
            remove_columns=["question", "context", "answer"]
        )
    else:
        # Find local JSON file relative to this script
        script_dir = Path(__file__).parent
        json_path = script_dir.parent / "evals" / "sql-create-context" / "sql-create-context.json"
        print(f"Loading dataset from {json_path}...")
        dataset = load_local_dataset(str(json_path), args.max_samples)
        print(f"Loaded {len(dataset)} examples")
        # Format for SFT
        print("Formatting dataset for SFT...")
        dataset = dataset.map(
            format_for_sft,
            remove_columns=["question", "context", "answer"]
        )

    # Split into train/eval
    splits = dataset.train_test_split(test_size=args.eval_split, seed=42)
    print(f"Train: {len(splits['train'])} examples")
    print(f"Eval: {len(splits['test'])} examples")
    print()

    # Configure training (full fine-tuning, no LoRA)
    training_args = SFTConfig(
        output_dir=args.output_dir,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch_size,
        per_device_eval_batch_size=args.batch_size,
        gradient_accumulation_steps=4,
        gradient_checkpointing=device_info["gradient_checkpointing"],
        learning_rate=args.lr,
        bf16=device_info["bf16"],
        fp16=device_info["fp16"],
        logging_steps=10,
        save_strategy="no",  # Don't save checkpoints during training (saves disk space)
        eval_strategy="no",  # Skip evaluation during training
        max_length=512,
        warmup_ratio=0.1,
        lr_scheduler_type="cosine",
        report_to="none",
        # For Mac MPS compatibility
        dataloader_pin_memory=device_info["device"] != "mps",
    )

    print("Initializing trainer (full fine-tuning, all weights)...")
    trainer = SFTTrainer(
        model=args.model,
        args=training_args,
        train_dataset=splits["train"],
        eval_dataset=splits["test"],
        # No peft_config = full fine-tuning
    )

    print("Starting training...")
    print()
    trainer.train()

    # Save final model
    final_path = f"{args.output_dir}-final"
    print(f"Saving model to {final_path}...")
    trainer.save_model(final_path)
    # Use processing_class instead of deprecated tokenizer
    if hasattr(trainer, 'processing_class') and trainer.processing_class is not None:
        trainer.processing_class.save_pretrained(final_path)
    elif hasattr(trainer, 'tokenizer') and trainer.tokenizer is not None:
        trainer.tokenizer.save_pretrained(final_path)

    # Convert to GGUF format
    gguf_path = None
    if not args.no_gguf:
        gguf_path = f"{final_path}.gguf"
        print()
        print("Converting to GGUF format...")
        try:
            convert_to_gguf(final_path, gguf_path, args.gguf_type)
            print(f"GGUF model saved to: {os.path.abspath(gguf_path)}")
        except RuntimeError as e:
            print(f"Warning: GGUF conversion failed: {e}")
            gguf_path = None

    print()
    print("=" * 50)
    print("Training complete!")
    print(f"Model saved to: {os.path.abspath(final_path)}")
    if gguf_path:
        print(f"GGUF model: {os.path.abspath(gguf_path)}")
    print("=" * 50)
    print()
    print("Next steps - Use your fine-tuned model:")
    print()
    if gguf_path:
        print("  LMStudio:")
        print(f"    lms import {os.path.abspath(gguf_path)} --user-repo local/qwen3-sql")
        print("    lms load local/qwen3-sql --gpu max")
        print()
        print("  Ollama:")
        print(f"    echo 'FROM {os.path.abspath(gguf_path)}' > Modelfile")
        print("    ollama create qwen3-sql -f Modelfile")
        print("    ollama run qwen3-sql")
    else:
        print("  Convert to GGUF manually:")
        print(f"    node packages/text2sql/src/finetune/convert-to-gguf.ts {final_path} {final_path}.gguf")
    print()


if __name__ == "__main__":
    main()
