from __future__ import annotations

import html
import re
from pathlib import Path


ROOT = Path(__file__).parent
MD = ROOT / "research_report_20260517_daytona_sandbox.md"
HTML = ROOT / "research_report_20260517_daytona_sandbox.html"


def convert_inline(text: str) -> str:
    escaped = html.escape(text)
    escaped = re.sub(r"`([^`]+)`", r"<code>\1</code>", escaped)
    escaped = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", escaped)
    return escaped


def flush_paragraph(lines: list[str], out: list[str]) -> None:
    if not lines:
        return
    out.append("<p>" + convert_inline(" ".join(lines)) + "</p>")
    lines.clear()


def convert_markdown(markdown: str) -> str:
    out: list[str] = []
    paragraph: list[str] = []
    in_code = False
    in_ul = False
    in_ol = False
    in_table = False

    def close_lists() -> None:
        nonlocal in_ul, in_ol
        if in_ul:
            out.append("</ul>")
            in_ul = False
        if in_ol:
            out.append("</ol>")
            in_ol = False

    for raw in markdown.splitlines():
        line = raw.rstrip()
        stripped = line.strip()

        if stripped == "---":
            continue

        if stripped.startswith("```"):
            flush_paragraph(paragraph, out)
            close_lists()
            if in_table:
                out.append("</tbody></table>")
                in_table = False
            if not in_code:
                out.append("<pre><code>")
                in_code = True
            else:
                out.append("</code></pre>")
                in_code = False
            continue

        if in_code:
            out.append(html.escape(raw))
            continue

        if not stripped:
            flush_paragraph(paragraph, out)
            close_lists()
            if in_table:
                out.append("</tbody></table>")
                in_table = False
            continue

        if stripped.startswith("## "):
            flush_paragraph(paragraph, out)
            close_lists()
            if in_table:
                out.append("</tbody></table>")
                in_table = False
            out.append(f'<h2 class="section-title">{convert_inline(stripped[3:])}</h2>')
            continue

        if stripped.startswith("### "):
            flush_paragraph(paragraph, out)
            close_lists()
            out.append(f"<h3>{convert_inline(stripped[4:])}</h3>")
            continue

        if stripped.startswith("|"):
            flush_paragraph(paragraph, out)
            close_lists()
            cells = [convert_inline(cell.strip()) for cell in stripped.strip("|").split("|")]
            if all(set(cell.replace(" ", "")) <= {"-"} for cell in cells):
                continue
            if not in_table:
                out.append("<table><tbody>")
                in_table = True
            tag = "th" if not any("<tr>" in row for row in out[-2:]) else "td"
            out.append("<tr>" + "".join(f"<{tag}>{cell}</{tag}>" for cell in cells) + "</tr>")
            continue

        if stripped.startswith("- "):
            flush_paragraph(paragraph, out)
            if not in_ul:
                close_lists()
                out.append("<ul>")
                in_ul = True
            out.append(f"<li>{convert_inline(stripped[2:])}</li>")
            continue

        if re.match(r"^\d+\. ", stripped):
            flush_paragraph(paragraph, out)
            if not in_ol:
                close_lists()
                out.append("<ol>")
                in_ol = True
            out.append(f"<li>{convert_inline(re.sub(r'^\\d+\\. ', '', stripped))}</li>")
            continue

        paragraph.append(stripped)

    flush_paragraph(paragraph, out)
    close_lists()
    if in_table:
        out.append("</tbody></table>")
    return "\n".join(out)


def main() -> None:
    markdown = MD.read_text()
    markdown = re.sub(r"^---.*?---\n", "", markdown, flags=re.S)
    markdown = re.sub(r"^# .+\n", "", markdown, count=1)
    body = convert_markdown(markdown)

    body = body.replace(
        '<h2 class="section-title">Bibliography</h2>',
        '</div><div class="bibliography"><h2 class="section-title">Bibliography</h2>',
        1,
    )
    body = re.sub(
        r"<p>\[(\d+)\] (.*?)</p>",
        r'<div class="bib-entry"><span class="bib-number">[\1]</span> \2</div>',
        body,
    )

    document = f"""<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Daytona Sandbox Integration Research</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.56; max-width: 980px; margin: 48px auto; padding: 0 24px; color: #111; }}
    .header {{ border-bottom: 1px solid #d8d8d8; margin-bottom: 28px; padding-bottom: 18px; }}
    h1 {{ font-size: 34px; line-height: 1.15; margin: 0 0 8px; }}
    h2 {{ margin-top: 36px; border-top: 1px solid #e3e3e3; padding-top: 22px; }}
    h3 {{ margin-top: 28px; }}
    code {{ background: #f3f3f3; padding: 1px 4px; border-radius: 4px; }}
    pre {{ background: #f7f7f7; padding: 16px; overflow: auto; }}
    table {{ border-collapse: collapse; width: 100%; margin: 16px 0; }}
    td, th {{ border: 1px solid #ddd; padding: 8px; text-align: left; vertical-align: top; }}
    .bibliography {{ font-size: 14px; margin-top: 44px; }}
    .bib-entry {{ margin: 8px 0; }}
  </style>
</head>
<body>
  <div class="header">
    <h1>Daytona Sandbox Integration Research for DeepAgents</h1>
    <p>Ultradeep research package generated 2026-05-17.</p>
  </div>
  <div class="content">
{body}
  </div>
</body>
</html>
"""
    HTML.write_text(document)


if __name__ == "__main__":
    main()
