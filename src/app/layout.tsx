import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SCS → STL Converter | HOOPS 3D Model Converter",
  description: "Convert HOOPS Stream Cache (.scs) files to STL format with 3D preview. Fast, private, browser-based conversion.",
  keywords: ["SCS to STL", "HOOPS", "3D model converter", "STL converter", "3D printing", "stream cache"],
  authors: [{ name: "SCS Converter" }],
  icons: {
    icon: "/favicon.ico",
  },
  openGraph: {
    title: "SCS → STL Converter",
    description: "Convert HOOPS SCS files to STL with 3D preview",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Preload HOOPS Communicator engine — 6.2MB total.
            Without these hints, the browser won't start downloading
            until React hydrates and the useEffect fires, wasting 2-5 seconds. */}
        <link rel="preload" href="/hoops/bundle.js" as="script" />
        <link rel="preload" href="/hoops/engine.esm.wasm" as="fetch" crossOrigin="anonymous" />
        {/* Also preload the root-level WASM copy that bundle.js may request */}
        <link rel="preload" href="/engine.esm.wasm" as="fetch" crossOrigin="anonymous" />
        {/* Start loading HOOPS bundle immediately — don't wait for React */}
        <script id="hoops-bundle" src="/hoops/bundle.js" async></script>
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
