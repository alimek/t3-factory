/** Render only supplied web references; never fetch or archive their contents. */
export function SessionResult({ text }: { text: string }) {
  return (
    <p className="break-words whitespace-pre-wrap">
      {text.split(/(https?:\/\/[^\s<>]*[^\s<>.,;:!?)])/g).map((part, index) =>
        /^https?:\/\//.test(part) ? (
          <a
            key={index}
            className="text-link hover:underline"
            href={part}
            target="_blank"
            rel="noreferrer"
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </p>
  );
}
