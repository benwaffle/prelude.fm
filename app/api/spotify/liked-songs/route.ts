import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Get the Spotify access token using better-auth's API
  const tokenResponse = await auth.api.getAccessToken({
    body: {
      providerId: "spotify",
      userId: session.user.id,
    },
    headers: await headers(),
  });

  if (!tokenResponse?.accessToken) {
    console.log("No Spotify access token found");
    return Response.json({ error: "No Spotify access token" }, { status: 401 });
  }

  const accessToken = tokenResponse.accessToken;

  // Get the URL from query params, or use the default
  const searchParams = request.nextUrl.searchParams;
  const url =
    searchParams.get("url") || "https://api.spotify.com/v1/me/tracks?limit=50";

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Spotify API error: ${response.status}`);
    }

    const data = await response.json();
    return Response.json(data);
  } catch (error) {
    console.error("Error fetching liked songs:", error);
    return Response.json(
      { error: "Failed to fetch liked songs" },
      { status: 500 }
    );
  }
}
