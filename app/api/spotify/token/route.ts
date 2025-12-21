import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export async function GET() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tokenResponse = await auth.api.getAccessToken({
    body: {
      providerId: "spotify",
      userId: session.user.id,
    },
    headers: await headers(),
  });

  if (!tokenResponse?.accessToken) {
    return Response.json({ error: "No Spotify access token" }, { status: 401 });
  }

  return Response.json({ accessToken: tokenResponse.accessToken });
}
