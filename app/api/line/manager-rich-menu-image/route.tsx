import { ImageResponse } from "next/og";

export const runtime = "edge";

export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "2500px",
          height: "843px",
          display: "flex",
          background: "#ffffff",
          color: "#193629",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            width: "1250px",
            height: "843px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            borderRight: "6px solid #d8e3dc",
          }}
        >
          <div style={{ fontSize: 118, fontWeight: 700 }}>MANAGER</div>
          <div style={{ marginTop: 34, fontSize: 54, fontWeight: 700 }}>OPEN</div>
        </div>
        <div
          style={{
            width: "1250px",
            height: "843px",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
          }}
        >
          <div style={{ fontSize: 104, fontWeight: 700 }}>CLOCK POSTER</div>
          <div style={{ marginTop: 34, fontSize: 54, fontWeight: 700 }}>OPEN</div>
        </div>
      </div>
    ),
    {
      width: 2500,
      height: 843,
      headers: {
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    },
  );
}
