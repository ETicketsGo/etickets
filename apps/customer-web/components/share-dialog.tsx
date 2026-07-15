'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Eye, Mail, MessageCircle, Repeat, Shield, Smartphone } from 'lucide-react';
import {
  errorMessage,
  useToast,
  type ShareExpiryValue,
  type SharePermissionValue,
  type WalletTicket,
} from '@eticketsgo/web-kit';
import { api } from '@/lib/api';
import { Button, Dialog, Select } from '@/components/ui';

const PERMISSIONS: {
  value: SharePermissionValue;
  label: string;
  hint: string;
  icon: typeof Eye;
}[] = [
  { value: 'VIEW', label: 'View only', hint: 'See the ticket. No QR, no check-in.', icon: Eye },
  {
    value: 'GUEST',
    label: 'Guest access',
    hint: 'Temporary access with a live QR to check in.',
    icon: Shield,
  },
  {
    value: 'TRANSFER',
    label: 'Transfer ownership',
    hint: 'Give the ticket away; their QR replaces yours.',
    icon: Repeat,
  },
];

const EXPIRIES: { value: ShareExpiryValue; label: string }[] = [
  { value: '1h', label: '1 hour' },
  { value: '6h', label: '6 hours' },
  { value: '24h', label: '24 hours' },
  { value: 'event_end', label: 'Until the event ends' },
  { value: 'never', label: 'Never' },
];

/** Secure Experience Sharing dialog: create a scoped, expiring, revocable link. */
export function ShareDialog({
  ticket,
  open,
  onClose,
}: {
  ticket: WalletTicket;
  open: boolean;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [permission, setPermission] = useState<SharePermissionValue>('VIEW');
  const [expiry, setExpiry] = useState<ShareExpiryValue>('24h');
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const shares = useQuery({
    queryKey: ['shares', ticket.id],
    queryFn: () => api.shareActivity(ticket.id),
    enabled: open,
  });

  const create = useMutation({
    mutationFn: () => api.createShare(ticket.id, { permission, expiry }),
    onSuccess: (res) => {
      setLink(res.shareUrl);
      setQr(res.qrDataUrl);
      qc.invalidateQueries({ queryKey: ['shares', ticket.id] });
      toast.push('Share link created.', 'success');
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.revokeShare(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shares', ticket.id] });
      toast.push('Share revoked.', 'success');
    },
    onError: (e) => toast.push(errorMessage(e), 'error'),
  });

  const reset = () => {
    setLink(null);
    setQr(null);
    setCopied(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const copy = async () => {
    if (!link) return;
    await navigator.clipboard.writeText(link).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const msg = link ? `Here's your ticket for ${ticket.event.title}: ${link}` : '';
  const channels = link
    ? [
        {
          label: 'WhatsApp',
          icon: MessageCircle,
          href: `https://wa.me/?text=${encodeURIComponent(msg)}`,
        },
        { label: 'SMS', icon: Smartphone, href: `sms:?&body=${encodeURIComponent(msg)}` },
        {
          label: 'Email',
          icon: Mail,
          href: `mailto:?subject=${encodeURIComponent(`Ticket: ${ticket.event.title}`)}&body=${encodeURIComponent(msg)}`,
        },
      ]
    : [];

  return (
    <Dialog open={open} onClose={close} title="Share this experience">
      {link ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={link}
              aria-label="Share link"
              className="min-w-0 flex-1 rounded-md border border-border bg-background-subtle px-3 py-2 font-mono text-caption text-text-secondary"
            />
            <Button variant="outline" size="sm" onClick={copy}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {channels.map((c) => (
              <a
                key={c.label}
                href={c.href}
                target="_blank"
                rel="noreferrer"
                className="flex flex-col items-center gap-1 rounded-lg border border-border px-2 py-3 text-caption font-medium text-text-secondary transition-colors hover:bg-background-subtle hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <c.icon className="h-4 w-4" />
                {c.label}
              </a>
            ))}
          </div>

          {qr && (
            <div className="flex flex-col items-center">
              <p className="mb-1.5 text-caption text-text-muted">Or let them scan this link</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qr}
                alt="QR code for the share link"
                className="h-40 w-40 rounded-lg bg-white p-2"
              />
            </div>
          )}

          <p className="text-caption text-text-muted">
            {permission === 'TRANSFER'
              ? 'When they accept, your QR is replaced — the old one stops working.'
              : permission === 'GUEST'
                ? 'They can view the live QR and check in until the link expires. Revoke it anytime.'
                : 'View-only — no QR and no check-in. Revoke it anytime.'}
          </p>

          <div className="flex justify-between">
            <Button variant="outline" onClick={reset}>
              New link
            </Button>
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <fieldset>
            <legend className="mb-2 text-caption font-medium text-text-secondary">
              What can they do?
            </legend>
            <div className="space-y-2">
              {PERMISSIONS.map((p) => (
                <label
                  key={p.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
                    permission === p.value
                      ? 'border-action-primary bg-action-primary/5'
                      : 'border-border hover:bg-background-subtle'
                  }`}
                >
                  <input
                    type="radio"
                    name="permission"
                    value={p.value}
                    checked={permission === p.value}
                    onChange={() => setPermission(p.value)}
                    className="mt-0.5 h-4 w-4 text-action-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  />
                  <span>
                    <span className="flex items-center gap-1.5 text-[0.9375rem] font-medium text-text-primary">
                      <p.icon className="h-3.5 w-3.5" /> {p.label}
                    </span>
                    <span className="text-caption text-text-muted">{p.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <Select
            id="share-expiry"
            label="Link expires"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value as ShareExpiryValue)}
          >
            {EXPIRIES.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </Select>

          {/* Existing shares */}
          {shares.data && shares.data.shares.length > 0 && (
            <div>
              <p className="mb-1.5 text-caption font-medium text-text-secondary">Active links</p>
              <ul className="space-y-1.5">
                {shares.data.shares
                  .filter((s) => s.status === 'PENDING')
                  .map((s) => (
                    <li
                      key={s.id}
                      className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-caption"
                    >
                      <span className="text-text-secondary">
                        {s.permission} · {s.openCount} open{s.openCount === 1 ? '' : 's'}
                      </span>
                      <button
                        onClick={() => revoke.mutate(s.id)}
                        className="font-medium text-status-error hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
              </ul>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button loading={create.isPending} onClick={() => create.mutate()}>
              Create link
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
