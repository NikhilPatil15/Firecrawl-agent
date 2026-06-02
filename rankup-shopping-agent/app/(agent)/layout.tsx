import { Metadata } from "next";
import localFont from "next/font/local";
import { GeistMono } from "geist/font/mono";
import ColorStyles from "@/components/shared/color-styles/color-styles";
import Scrollbar from "@/components/ui/scrollbar";
import Providers from "@/app/providers";
import "@/styles/main.css";
import "streamdown/styles.css";

const suisseIntl = localFont({
  src: [
    { path: "../../public/fonts/SuisseIntl/400.woff2", weight: "400" },
    { path: "../../public/fonts/SuisseIntl/450.woff2", weight: "450" },
    { path: "../../public/fonts/SuisseIntl/500.woff2", weight: "500" },
    { path: "../../public/fonts/SuisseIntl/600.woff2", weight: "600" },
    { path: "../../public/fonts/SuisseIntl/700.woff2", weight: "700" },
  ],
  variable: "--font-suisse",
});

export const metadata: Metadata = {
  title: "ShopSmart 🧠",
  description:
    "AI-powered student shopping assistant that finds the best deals, compares prices, and hunts coupons across stores.",
  icons: { icon: "/favicon.png" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ColorStyles />
        {/* Resolve theme before first paint to avoid a flash of the wrong mode */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('shopsmart:theme')||'system';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`,
          }}
        />
      </head>
      <body
        className={`${suisseIntl.variable} ${GeistMono.variable} font-sans text-accent-black bg-background-base overflow-x-clip`}
      >
        <Providers>
          <main className="overflow-x-clip">{children}</main>
        </Providers>
        <Scrollbar />
      </body>
    </html>
  );
}
