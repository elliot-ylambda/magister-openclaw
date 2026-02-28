import { ImageResponse } from "next/og";
import { LogoSvg } from "./logo-svg";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#000000",
          borderRadius: "6px",
        }}
      >
        <LogoSvg size={24} />
      </div>
    ),
    { ...size }
  );
}
