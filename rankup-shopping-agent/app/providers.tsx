"use client";

import { SessionProvider } from "next-auth/react";
import { ThemeProvider } from "@agent/_components/theme";

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <ThemeProvider>{children}</ThemeProvider>
    </SessionProvider>
  );
}
