// Lazily loads the Razorpay Standard Checkout script and resolves with the
// `window.Razorpay` constructor. The <script> is injected once (subsequent
// callers reuse the same in-flight promise / already-loaded global). This is
// the only place the external checkout script is loaded, and only on demand
// from the INR payment flow.
const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

let loader: Promise<RazorpayConstructor> | null = null;

export function loadRazorpay(): Promise<RazorpayConstructor> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Razorpay Checkout is only available in the browser.'));
  }
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loader) return loader;

  loader = new Promise<RazorpayConstructor>((resolve, reject) => {
    const settle = () => {
      if (window.Razorpay) resolve(window.Razorpay);
      else reject(new Error('Razorpay Checkout failed to initialise.'));
    };
    const fail = () => {
      // Allow a later retry to re-inject the script.
      loader = null;
      reject(new Error('Could not load Razorpay Checkout. Please check your connection.'));
    };

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHECKOUT_SRC}"]`);
    if (existing) {
      if (window.Razorpay) return resolve(window.Razorpay);
      existing.addEventListener('load', settle, { once: true });
      existing.addEventListener('error', fail, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = CHECKOUT_SRC;
    script.async = true;
    script.addEventListener('load', settle, { once: true });
    script.addEventListener('error', fail, { once: true });
    document.body.appendChild(script);
  });

  return loader;
}
