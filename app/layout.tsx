import "./globals.css";
import type { Metadata } from "next";
export const metadata: Metadata = { title: "Pawtra Artwork Portal", description: "Review, revise and approve your custom Pawtra artwork." };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body><header className="header"><div className="container"><a className="brand" href="https://pawtra.net">PAWTRA</a><a href="/track">Track My Order</a></div></header>{children}</body></html>; }
