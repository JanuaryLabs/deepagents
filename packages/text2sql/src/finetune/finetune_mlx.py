"""
MLX fine-tuning of LLMs on sql-create-context dataset.

Native Apple Silicon support (M1/M2/M3/M4) using MLX framework.
Uses LoRA for efficient fine-tuning with unified memory.

Usage:
    python finetune_mlx.py [options]

Options:
    --iters         Number of training iterations (default: 1000)
    --batch-size    Batch size (default: 4)
    --lr            Learning rate (default: 1e-5)
    --output-dir    Output directory (default: ./qwen3-sql-mlx)
    --max-samples   Limit training samples (default: all)
    --use-hf        Use HuggingFace dataset instead of local JSON
    --model         Base model (default: Qwen/Qwen3-0.5B)
    --num-layers    Number of LoRA layers (default: 16)
    --no-gguf       Disable GGUF export
"""

import argparse
import json
import os
import platform
import subprocess
import sys
from pathlib import Path


def check_apple_silicon():
    """Check if running on Apple Silicon."""
    if platform.system() != "Darwin":
        print("=" * 60)
        print("ERROR: Not running on macOS")
        print("=" * 60)
        print()
        print("MLX requires macOS with Apple Silicon (M1/M2/M3/M4).")
        print()
        print("For other platforms, use:")
        print("  - Linux/Windows with NVIDIA GPU: finetune_sql.py")
        print()
        sys.exit(1)

    if platform.machine() not in ("arm64", "aarch64"):
        print("=" * 60)
        print("WARNING: Not running on Apple Silicon")
        print("=" * 60)
        print()
        print("MLX works best on Apple Silicon (M1/M2/M3/M4).")
        print("Performance on Intel Macs will be limited.")
        print()


def prepare_data(
    output_dir: str,
    max_samples: int | None = None,
    use_hf: bool = False,
    eval_split: float = 0.1
) -> str:
    """Convert sql-create-context to MLX JSONL format."""
    from datasets import Dataset, load_dataset

    # Load dataset
    if use_hf:
        print("Loading dataset from HuggingFace...")
        dataset = load_dataset("b-mc2/sql-create-context", split="train")
        if max_samples:
            dataset = dataset.select(range(min(max_samples, len(dataset))))
    else:
        script_dir = Path(__file__).parent
        json_path = script_dir.parent / "evals" / "sql-create-context" / "sql-create-context.json"
        print(f"Loading dataset from {json_path}...")
        with open(json_path) as f:
            data = json.load(f)
        rows = data["rows"]
        if max_samples:
            rows = rows[:max_samples]
        dataset = Dataset.from_list([row["row"] for row in rows])

    print(f"Loaded {len(dataset)} examples")

    # Convert to MLX chat format
    def to_chat_format(example):
        user_content = f"""Given the following SQL schema:
{example["context"]}

Write a SQL query to answer: {example["question"]}"""
        return {
            "messages": [
                {"role": "user", "content": user_content},
                {"role": "assistant", "content": example["answer"]}
            ]
        }

    print("Converting to chat format...")
    dataset = dataset.map(to_chat_format, remove_columns=["question", "context", "answer"])

    # Split into train/valid
    splits = dataset.train_test_split(test_size=eval_split, seed=42)
    print(f"Train: {len(splits['train'])} examples")
    print(f"Valid: {len(splits['test'])} examples")

    # Create data directory
    data_dir = os.path.join(output_dir, "data")
    os.makedirs(data_dir, exist_ok=True)

    # Write JSONL files
    train_path = os.path.join(data_dir, "train.jsonl")
    valid_path = os.path.join(data_dir, "valid.jsonl")

    with open(train_path, "w") as f:
        for example in splits["train"]:
            f.write(json.dumps(example) + "\n")

    with open(valid_path, "w") as f:
        for example in splits["test"]:
            f.write(json.dumps(example) + "\n")

    print(f"Data saved to {data_dir}")
    return data_dir


def run_training(
    model: str,
    data_dir: str,
    output_dir: str,
    iters: int,
    batch_size: int,
    learning_rate: float,
    num_layers: int,
) -> str:
    """Run MLX LoRA training."""
    adapter_path = os.path.join(output_dir, "adapters")

    cmd = [
        sys.executable, "-m", "mlx_lm.lora",
        "--model", model,
        "--train",
        "--data", data_dir,
        "--adapter-path", adapter_path,
        "--iters", str(iters),
        "--batch-size", str(batch_size),
        "--learning-rate", str(learning_rate),
        "--num-layers", str(num_layers),
    ]

    print()
    print(f"Running: {' '.join(cmd)}")
    print()

    subprocess.run(cmd, check=True)
    return adapter_path


def fuse_and_export(
    model: str,
    adapter_path: str,
    output_dir: str,
    export_gguf: bool = True
) -> tuple[str, str | None]:
    """Fuse adapters into model and optionally export to GGUF."""
    fused_path = os.path.join(output_dir, "fused_model")

    cmd = [
        sys.executable, "-m", "mlx_lm.fuse",
        "--model", model,
        "--adapter-path", adapter_path,
        "--save-path", fused_path,
    ]

    if export_gguf:
        cmd.append("--export-gguf")

    print()
    print(f"Running: {' '.join(cmd)}")
    print()

    subprocess.run(cmd, check=True)

    gguf_path = None
    if export_gguf:
        potential_gguf = os.path.join(fused_path, "ggml-model-f16.gguf")
        if os.path.exists(potential_gguf):
            gguf_path = potential_gguf

    return fused_path, gguf_path


def main():
    check_apple_silicon()

    parser = argparse.ArgumentParser(description="Fine-tune with MLX (Apple Silicon)")
    parser.add_argument("--iters", type=int, default=1000, help="Number of training iterations")
    parser.add_argument("--batch-size", type=int, default=4, help="Batch size")
    parser.add_argument("--lr", type=float, default=1e-5, help="Learning rate")
    parser.add_argument("--output-dir", type=str, default="./qwen3-sql-mlx", help="Output directory")
    parser.add_argument("--max-samples", type=int, default=None, help="Limit training samples")
    parser.add_argument("--use-hf", action="store_true", help="Use HuggingFace dataset")
    parser.add_argument("--model", type=str, default="Qwen/Qwen3-0.5B", help="Base model")
    parser.add_argument("--num-layers", type=int, default=16, help="Number of LoRA layers")
    parser.add_argument("--eval-split", type=float, default=0.1, help="Evaluation split ratio")
    parser.add_argument("--no-gguf", action="store_true", help="Disable GGUF export")
    args = parser.parse_args()

    print("=" * 60)
    print("MLX Fine-Tuning (Apple Silicon)")
    print("=" * 60)
    print()
    print(f"Platform: {platform.system()} {platform.machine()}")
    print(f"Model: {args.model}")
    print(f"Iterations: {args.iters}")
    print(f"Batch size: {args.batch_size}")
    print(f"Learning rate: {args.lr}")
    print(f"LoRA layers: {args.num_layers}")
    print(f"Output: {args.output_dir}")
    print(f"Max samples: {args.max_samples or 'all'}")
    print()

    # Create output directory
    os.makedirs(args.output_dir, exist_ok=True)

    # Step 1: Prepare data
    print("=" * 40)
    print("Step 1: Preparing data")
    print("=" * 40)
    data_dir = prepare_data(
        args.output_dir,
        args.max_samples,
        args.use_hf,
        args.eval_split
    )

    # Step 2: Train
    print()
    print("=" * 40)
    print("Step 2: Training with LoRA")
    print("=" * 40)
    adapter_path = run_training(
        args.model,
        data_dir,
        args.output_dir,
        args.iters,
        args.batch_size,
        args.lr,
        args.num_layers,
    )

    # Step 3: Fuse and export
    print()
    print("=" * 40)
    print("Step 3: Fusing adapters" + (" and exporting GGUF" if not args.no_gguf else ""))
    print("=" * 40)
    fused_path, gguf_path = fuse_and_export(
        args.model,
        adapter_path,
        args.output_dir,
        export_gguf=not args.no_gguf
    )

    # Summary
    print()
    print("=" * 60)
    print("Training complete!")
    print("=" * 60)
    print()
    print(f"Adapters:    {os.path.abspath(adapter_path)}")
    print(f"Fused model: {os.path.abspath(fused_path)}")
    if gguf_path:
        print(f"GGUF model:  {os.path.abspath(gguf_path)}")
    print()
    print("Next steps - Use your fine-tuned model:")
    print()
    if gguf_path:
        print("  LMStudio:")
        print(f"    lms import {os.path.abspath(gguf_path)} --user-repo local/qwen3-sql-mlx")
        print("    lms load local/qwen3-sql-mlx --gpu max")
        print()
        print("  Ollama:")
        print(f"    echo 'FROM {os.path.abspath(gguf_path)}' > Modelfile")
        print("    ollama create qwen3-sql-mlx -f Modelfile")
        print("    ollama run qwen3-sql-mlx")
    else:
        print("  Generate with MLX:")
        print(f"    mlx_lm.generate --model {fused_path} --prompt 'Your prompt'")
    print()


if __name__ == "__main__":
    main()
