'use client';

import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Copy, Check, Download, QrCode, Share2, Mail, ExternalLink } from 'lucide-react';
import { api, Card, Button, Skeleton, ErrorState, EmptyState, useToast } from '@eticketsgo/web-kit';

/** Build the promotional poster (title + QR + link) as a PNG data URL, client-side. */
async function buildPoster(title: string, url: string, qrDataUrl: string): Promise<string> {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#4f46e5');
  grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#c7d2fe';
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.fillText("YOU'RE INVITED", 90, 150);

  // Wrapped title.
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 78px system-ui, sans-serif';
  const words = title.split(' ');
  let line = '';
  let y = 300;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > W - 180 && line) {
      ctx.fillText(line, 90, y);
      line = word;
      y += 96;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, 90, y);

  // QR panel.
  const qr = new Image();
  await new Promise<void>((resolve, reject) => {
    qr.onload = () => resolve();
    qr.onerror = () => reject(new Error('QR image failed to load'));
    qr.src = qrDataUrl;
  });
  const qrSize = 460;
  const qrX = (W - qrSize) / 2;
  const qrY = 720;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(qrX - 30, qrY - 30, qrSize + 60, qrSize + 60);
  ctx.drawImage(qr, qrX, qrY, qrSize, qrSize);

  ctx.fillStyle = '#e0e7ff';
  ctx.font = '500 30px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Scan to get your tickets', W / 2, qrY + qrSize + 90);
  ctx.fillText(url, W / 2, qrY + qrSize + 140);
  ctx.textAlign = 'left';

  return canvas.toDataURL('image/png');
}

function downloadDataUrl(dataUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function PromoteTab() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  const [posterBusy, setPosterBusy] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['event-promotion', id],
    queryFn: () => api.events.promotion(id),
  });

  if (isError)
    return (
      <ErrorState
        message="We couldn't load your marketing links. Please try again."
        onRetry={() => refetch()}
      />
    );
  if (isLoading || !data) return <Skeleton className="h-64 w-full" />;

  const { title, publicUrl, qrDataUrl, published } = data;

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 2000);
    } catch {
      toast.push('Copy failed — you can select the text manually.', 'error');
    }
  };

  const shareText = `Get your tickets for ${title}`;
  const enc = encodeURIComponent;
  const socials = [
    {
      name: 'X',
      href: `https://twitter.com/intent/tweet?text=${enc(shareText)}&url=${enc(publicUrl)}`,
    },
    { name: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${enc(publicUrl)}` },
    {
      name: 'LinkedIn',
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(publicUrl)}`,
    },
    { name: 'WhatsApp', href: `https://wa.me/?text=${enc(`${shareText} ${publicUrl}`)}` },
  ];

  const emailTemplate = `Subject: You're invited to ${title}

Hi there,

I'd love for you to join me at ${title}. Grab your tickets here:
${publicUrl}

Hope to see you there!`;

  const downloadPoster = async () => {
    setPosterBusy(true);
    try {
      const poster = await buildPoster(title, publicUrl, qrDataUrl);
      downloadDataUrl(poster, `${data.slug}-poster.png`);
    } catch {
      toast.push('Could not generate the poster. Please try again.', 'error');
    } finally {
      setPosterBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-title font-semibold text-text-primary">Promote this event</h2>
          <p className="mt-1 text-caption text-text-secondary">
            Share your event page, download assets, and invite your audience.
          </p>
        </div>
      </div>

      {!published && (
        <div className="rounded-xl border border-status-warning/30 bg-status-warning/5 px-4 py-3 text-caption text-status-warning">
          This event isn&rsquo;t published yet. These links will only work for visitors once
          it&rsquo;s live.
        </div>
      )}

      <Card title="Event link">
        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              readOnly
              value={publicUrl}
              className="flex-1 rounded-lg border border-border-strong bg-surface-muted px-3 py-2 text-sm text-text-primary"
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => copy(publicUrl, 'link')}
                aria-label="Copy event link"
              >
                {copied === 'link' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied === 'link' ? 'Copied' : 'Copy link'}
              </Button>
              <a href={publicUrl} target="_blank" rel="noopener noreferrer">
                <Button variant="ghost" size="sm">
                  <ExternalLink className="h-4 w-4" />
                  Open
                </Button>
              </a>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <span className="inline-flex items-center gap-1.5 text-caption text-text-muted">
              <Share2 className="h-4 w-4" /> Share on
            </span>
            {socials.map((s) => (
              <a key={s.name} href={s.href} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm">
                  {s.name}
                </Button>
              </a>
            ))}
          </div>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="QR code & poster">
          <div className="flex flex-col items-center gap-4">
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrDataUrl}
                alt={`QR code linking to ${title}`}
                className="h-48 w-48 rounded-lg border border-border-subtle bg-white p-2"
              />
            ) : (
              <EmptyState icon={QrCode} title="No QR code" hint="Try refreshing." />
            )}
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => downloadDataUrl(qrDataUrl, `${data.slug}-qr.png`)}
              >
                <Download className="h-4 w-4" />
                Download QR
              </Button>
              <Button variant="primary" size="sm" loading={posterBusy} onClick={downloadPoster}>
                <Download className="h-4 w-4" />
                Download poster
              </Button>
            </div>
          </div>
        </Card>

        <Card title="Email invitation">
          <div className="space-y-3">
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border-subtle bg-surface-muted p-3 text-caption text-text-secondary">
              {emailTemplate}
            </pre>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => copy(emailTemplate, 'email')}>
                {copied === 'email' ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied === 'email' ? 'Copied' : 'Copy template'}
              </Button>
              <a
                href={`mailto:?subject=${enc(`You're invited to ${title}`)}&body=${enc(
                  `${shareText}\n${publicUrl}`,
                )}`}
              >
                <Button variant="ghost" size="sm">
                  <Mail className="h-4 w-4" />
                  Open in email
                </Button>
              </a>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
