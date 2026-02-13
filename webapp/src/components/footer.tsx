import Image from "next/image";

export function Footer() {
  return (
    <footer className="border-t border-white/5 py-8 px-6">
      <div className="max-w-7xl mx-auto flex justify-between items-center">
        <span className="flex items-center gap-2 text-sm text-gray-500 font-semibold">
          <Image src="/magister-logo-white.svg" alt="Magister" width={20} height={22} className="opacity-50" />
          Magister
        </span>
        <span className="text-sm text-gray-500">Built on OpenClaw</span>
      </div>
    </footer>
  );
}
