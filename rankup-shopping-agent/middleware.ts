import { NextResponse } from "next/server";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.png|rankup_icon_3.png|fonts).*)"],
};

// TEMP: bypass auth entirely for local testing
export default function middleware() {
  return NextResponse.next();
}
