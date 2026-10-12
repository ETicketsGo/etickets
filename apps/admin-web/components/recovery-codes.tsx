'use client';

import { Button, useToast } from '@eticketsgo/web-kit';

/**
 * Recovery codes, shown exactly once. The page holding them keeps them in component state only:
 * they are never stored, never put in a URL and cannot be read back from the API.
 */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone?: () => void }) {
  const toast = useToast();
  const text = codes.join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.push('Codes copied.', 'success');
    } catch {
      toast.push('Copy failed. Select the codes and copy them by hand.', 'error');
    }
  };

  const download = () => {
    const blob = new Blob([`ETicketsGo recovery codes\nEach code works once.\n\n${text}\n`], {
      type: 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'eticketsgo-recovery-codes.txt';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <p className="text-[0.9375rem] text-text-primary">
        Save these recovery codes now. Each one works once, if you lose your phone. We cannot show
        them again.
      </p>
      <ul
        aria-label="Recovery codes"
        className="grid grid-cols-2 gap-2 rounded-md border border-border bg-background-canvas p-3 font-mono text-[0.9375rem] text-text-primary"
      >
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={copy}>
          Copy
        </Button>
        <Button variant="outline" size="sm" onClick={download}>
          Download
        </Button>
        {onDone && (
          <Button size="sm" onClick={onDone}>
            I have saved them
          </Button>
        )}
      </div>
    </div>
  );
}
