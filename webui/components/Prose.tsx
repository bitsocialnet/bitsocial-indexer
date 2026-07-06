import { Fragment } from 'react';

/**
 * Plain-text post content, rendered line-aware so quote lines ("&gt;greentext")
 * can be tinted via the .greentext token. Whitespace is preserved by the
 * .prose pre-wrap style; no markup in the source text is interpreted.
 */
export function Prose({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <p className="prose">
      {lines.map((line, i) => (
        <Fragment key={i}>
          {i > 0 ? '\n' : null}
          {line.startsWith('>') ? <span className="greentext">{line}</span> : line}
        </Fragment>
      ))}
    </p>
  );
}
