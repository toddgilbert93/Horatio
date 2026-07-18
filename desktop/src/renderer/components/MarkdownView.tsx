/** Minimal markdown: headings + paragraphs; preserves verbatim structure. */
export function MarkdownView({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <div className="markdown">
      {lines.map((line, i) => {
        if (line.startsWith('# ')) return <div key={i} className="h" style={{ fontSize: '1.2rem' }}>{line.slice(2)}</div>;
        if (line.startsWith('## ')) return <div key={i} className="h" style={{ fontSize: '1.05rem' }}>{line.slice(3)}</div>;
        if (line.startsWith('### ')) return <div key={i} className="h">{line.slice(4)}</div>;
        if (line.trim() === '') return <br key={i} />;
        return <div key={i}>{line}</div>;
      })}
    </div>
  );
}
