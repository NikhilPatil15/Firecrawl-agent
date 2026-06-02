import { redirect } from "next/navigation";
import { auth, signIn } from "@/auth";
import SymbolColored from "@/components/shared/icons/symbol-colored";

function GoogleGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden>
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.07 5.07 0 01-2.2 3.32v2.77h3.56c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.56-2.77c-.98.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0012 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.11A6.6 6.6 0 015.5 12c0-.73.13-1.44.34-2.11V7.05H2.18a11 11 0 000 9.9l3.66-2.84z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 002.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
        fill="#EA4335"
      />
    </svg>
  );
}

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="text-heat-100">
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

const BENEFITS = [
  "Compares prices in real time",
  "Surfaces verified coupons",
  "Checks out for you, stopping before payment",
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}) {
  const session = await auth();
  if (session) redirect("/");

  const params = await searchParams;
  const callbackUrl = params.callbackUrl ?? "/";
  const error = params.error;

  return (
    <div className="min-h-[100dvh] bg-background-base relative overflow-hidden flex flex-col">
      {/* Ambient heat-glow flourishes */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-[300px] left-1/2 -translate-x-1/2 w-[820px] h-[600px] rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, rgba(15,161,92,0.13), rgba(15,161,92,0))",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-[260px] left-1/2 -translate-x-1/2 w-[640px] h-[560px] rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, rgba(110,237,27,0.08), rgba(110,237,27,0))",
        }}
      />

      {/* Brand header — spans the full centered container width */}
      <header className="relative z-1 mx-auto w-full max-w-[1080px] px-24 sm:px-32 pt-28 flex items-center gap-12">
        <SymbolColored width={34} height={48} />
        <span className="text-title-h5 text-accent-black tracking-tight">ShopSmart</span>
      </header>

      {/* Split layout grouped in a centered max-width container so the two
          columns sit together in the middle instead of hugging screen edges. */}
      <div className="relative z-1 flex-1 mx-auto w-full max-w-[1080px] px-24 sm:px-32 grid items-center gap-32 lg:gap-56 lg:grid-cols-[1.05fr_minmax(340px,400px)] py-32">
        {/* LEFT — editorial pitch */}
        <section className="relative">
          <div>
            <div className="flex items-center gap-8 mb-20">
              <span className="relative flex h-6 w-6">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-heat-100 opacity-60" />
                <span className="relative inline-flex h-6 w-6 rounded-full bg-heat-100" />
              </span>
              <span className="text-mono-x-small tracking-wide text-black-alpha-48 uppercase">
                Built for students in India
              </span>
            </div>

            <h1
              className="text-accent-black text-balance"
              style={{
                fontSize: "clamp(34px, 4.6vw, 54px)",
                lineHeight: 1.03,
                letterSpacing: "-0.03em",
                fontWeight: 500,
              }}
            >
              Your personal<br />
              <span className="text-black-alpha-40">shopping agent.</span>
            </h1>

            <p className="mt-18 text-body-x-large text-black-alpha-56 max-w-[460px] text-pretty">
              Real-time price comparison, verified coupons, and hands-free checkout
              — across India&apos;s leading stores.
            </p>

            <ul className="mt-32 flex flex-col gap-14 max-w-[480px]">
              {BENEFITS.map((b) => (
                <li key={b} className="flex items-start gap-12">
                  <span className="flex-shrink-0 mt-2 flex items-center justify-center w-22 h-22 rounded-full bg-heat-8">
                    <CheckIcon />
                  </span>
                  <span className="text-body-medium text-accent-black/80 text-pretty">{b}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* RIGHT — auth card */}
        <section className="relative flex items-center justify-center">
          <div
            className="w-full bg-accent-white rounded-16 border border-border-muted p-26 flex flex-col gap-16"
            style={{
              boxShadow:
                "0 24px 48px -16px rgba(15,161,92,0.12), 0 8px 16px -8px rgba(0,0,0,0.06)",
            }}
          >
            <div>
              <div className="text-mono-x-small uppercase tracking-wider text-heat-100 mb-6">
                Sign in
              </div>
              <h2 className="text-title-h5 text-accent-black tracking-tight">
                Get started
              </h2>
              <p className="mt-4 text-body-small text-black-alpha-48 text-pretty">
                Sign in with Google. New here? Your account is created automatically.
              </p>
            </div>

            {error && (
              <div className="px-12 py-10 rounded-8 bg-accent-crimson/8 text-body-small text-accent-crimson">
                {error === "OAuthAccountNotLinked"
                  ? "This email is already linked to another sign-in method."
                  : "Sign-in failed. Please try again."}
              </div>
            )}

            <form
              action={async () => {
                "use server";
                await signIn("google", { redirectTo: callbackUrl });
              }}
            >
              <button
                type="submit"
                className="w-full flex items-center justify-center gap-10 px-16 py-12 rounded-10 bg-heat-100 text-accent-white text-label-medium hover:bg-[color:var(--heat-90)] transition-all active:scale-[0.99] shadow-[0_8px_20px_-8px_rgba(15,161,92,0.5)]"
              >
                <span className="flex items-center justify-center w-22 h-22 rounded-full bg-accent-white">
                  <GoogleGlyph />
                </span>
                Continue with Google
              </button>
            </form>

            <div className="flex items-start gap-8 px-12 py-10 rounded-10 bg-black-alpha-3">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="text-black-alpha-40 flex-shrink-0 mt-1">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
              <p className="text-mono-x-small text-black-alpha-48 leading-relaxed">
                ShopSmart never enters your card number, UPI PIN, or OTP —
                checkout always stops at the payment step.
              </p>
            </div>
          </div>
        </section>
      </div>

      {/* Footer — spans the full centered container */}
      <footer className="relative z-1 mx-auto w-full max-w-[1080px] px-24 sm:px-32 py-24 flex items-center justify-between text-mono-x-small text-black-alpha-32">
        <span>ShopSmart · {new Date().getFullYear()}</span>
        <span>
          Powered by{" "}
          <a
            href="https://app.rankup.diy"
            target="_blank"
            rel="noopener noreferrer"
            className="text-black-alpha-48 hover:text-heat-100 transition-colors"
          >
            RankUp
          </a>
        </span>
      </footer>
    </div>
  );
}
