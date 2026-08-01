from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
SKILL = Path('/Users/ezzabuzaid/.agents/skills/deep-research')

spec = spec_from_file_location('md_to_html', SKILL / 'scripts/md_to_html.py')
module = module_from_spec(spec)
assert spec and spec.loader
spec.loader.exec_module(module)

content, bibliography = module.convert_markdown_to_html(
    (ROOT / 'report.md').read_text()
)
bibliography = '\n'.join(
    f'<div class="bib-entry"><span class="bib-number">[{match.group(1)}]</span> {match.group(2)}</div>'
    if (match := re.match(r'^\[(\d+)\]\s*(.+)$', line.strip()))
    else line
    for line in bibliography.splitlines()
)
template = (SKILL / 'templates/mckinsey_report_template.html').read_text()

metrics = '''
<div class="metrics-dashboard">
  <div class="metric"><span class="metric-number">2</span><span class="metric-label">SQL engines</span></div>
  <div class="metric"><span class="metric-number">24</span><span class="metric-label">Verified sources</span></div>
  <div class="metric"><span class="metric-number">3</span><span class="metric-label">Query API concurrency</span></div>
  <div class="metric"><span class="metric-number">10s</span><span class="metric-label">Query execution cap</span></div>
</div>
'''

print_css = '''
@page {
  size: A4;
  margin: 20mm 16mm 20mm 16mm;
  @top-center { content: "PostHog SQL Integration Research"; font-size: 8pt; color: #666; }
  @bottom-center { content: counter(page); font-size: 8pt; color: #666; }
}
@page :first { @top-center { content: none; } }
@media print {
  body { font-size: 9.5pt; line-height: 1.5; }
  .header h1 { font-size: 20pt; }
  .header-meta, .metric-label { font-size: 8pt; }
  .metric-number { font-size: 20pt; }
  .metrics-dashboard { display: table; width: 100%; table-layout: fixed; page-break-inside: avoid; }
  .metric { display: table-cell; width: 25%; padding: 9pt 6pt; }
  .content { padding: 18pt 20pt; }
  .section-title { font-size: 13pt; page-break-after: avoid; }
  .subsection-title, h3, h4 { font-size: 10.5pt; page-break-after: avoid; }
  p { orphans: 3; widows: 3; }
  table, pre, blockquote, .executive-summary, .key-insight, .info-box { page-break-inside: avoid; }
  table { font-size: 7.5pt; }
  th, td { padding: 5pt 6pt; }
  .bibliography { page-break-before: always; padding: 12pt; }
  .bib-entry, .bibliography p { font-size: 7.5pt; line-height: 1.4; page-break-inside: avoid; }
  .citation { font-size: 8pt; border-radius: 0; }
}
'''

html = (
    template.replace('{{TITLE}}', 'PostHog as a SQL Data Source')
    .replace('{{DATE}}', '2026-07-31')
    .replace('{{SOURCE_COUNT}}', '24')
    .replace('{{METRICS_DASHBOARD}}', metrics)
    .replace('{{CONTENT}}', content)
    .replace('{{BIBLIOGRAPHY}}', bibliography)
    .replace('</style>', print_css + '\n</style>')
)
(ROOT / 'report.html').write_text(html)
