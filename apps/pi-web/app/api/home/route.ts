import { NextResponse } from "next/server";
import { runtimeHomeDirectory } from "@/lib/runtime-home";

export async function GET() {
  return NextResponse.json({ home: runtimeHomeDirectory() });
}
