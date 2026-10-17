import { redirect } from '@/i18n/navigation';

/*
  A cancellation policy is something a reviewer asks for by name (the DLT registration review
  among them), and "/cancellation" is the address they try. The policy itself is part of the
  Refund and Cancellation Policy, so this sends them there rather than keeping a second copy
  that would drift from the first. The locale is carried, as on every redirect in this app.
*/
export default async function CancellationRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect({ href: '/refunds#cancellation', locale });
}
