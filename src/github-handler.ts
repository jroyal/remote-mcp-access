import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { Octokit } from "octokit";
import {
  fetchUpstreamAuthToken,
  getUpstreamAuthorizeUrl,
  Props,
} from "./utils";
import { env } from "cloudflare:workers";
import {
  clientIdAlreadyApproved,
  parseRedirectApproval,
  renderApprovalDialog,
} from "./workers-oauth-utils";

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();
app.get("/", async (c) => {
  return c.text("heyo james");
});

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  const { clientId } = oauthReqInfo;
  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  if (
    await clientIdAlreadyApproved(
      c.req.raw,
      oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY
    )
  ) {
    return redirectToAccess(c.req.raw, oauthReqInfo);
  }

  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    server: {
      name: "Cloudflare Access MCP Server",
      logo: "https://avatars.githubusercontent.com/u/314135?s=200&v=4",
      description:
        "This is a demo MCP Remote Server using Access for authentication.", // optional
    },
    state: { oauthReqInfo }, // arbitrary data that flows through the form submission below
  });
});

app.post("/authorize", async (c) => {
  // Validates form submission, extracts state, and generates Set-Cookie headers to skip approval dialog next time
  const { state, headers } = await parseRedirectApproval(
    c.req.raw,
    c.env.COOKIE_ENCRYPTION_KEY
  );
  if (!state.oauthReqInfo) {
    return c.text("Invalid request", 400);
  }

  return redirectToAccess(c.req.raw, state.oauthReqInfo, headers);
});

async function redirectToAccess(
  request: Request,
  oauthReqInfo: AuthRequest,
  headers: Record<string, string> = {}
) {
  return new Response(null, {
    status: 302,
    headers: {
      ...headers,
      location: getUpstreamAuthorizeUrl({
        upstream_url:
          "https://james.cloudflareaccess.com/cdn-cgi/access/sso/oidc/69e669cd8e007fd178050ccbaf6edd6a52cfda704251be2c14a26bbbd5998120/authorization",
        scope: "openid email profile",
        client_id: env.GITHUB_CLIENT_ID,
        redirect_uri: new URL("/callback", request.url).href,
        state: btoa(JSON.stringify(oauthReqInfo)),
      }),
    },
  });
}

/**
 * OAuth Callback Endpoint
 *
 * This route handles the callback from GitHub after user authentication.
 * It exchanges the temporary code for an access token, then stores some
 * user metadata & the auth token as part of the 'props' on the token passed
 * down to the client. It ends by redirecting the client back to _its_ callback URL
 */
app.get("/callback", async (c) => {
  console.log("CALLBACK CALLED");
  // Get the oathReqInfo out of KV
  const oauthReqInfo = JSON.parse(
    atob(c.req.query("state") as string)
  ) as AuthRequest;
  if (!oauthReqInfo.clientId) {
    return c.text("Invalid state", 400);
  }

  // Exchange the code for an access token
  console.log("CODE", c.req.query("code"), c.req.url);
  const [accessToken, errResponse] = await fetchUpstreamAuthToken({
    upstream_url:
      "https://james.cloudflareaccess.com/cdn-cgi/access/sso/oidc/69e669cd8e007fd178050ccbaf6edd6a52cfda704251be2c14a26bbbd5998120/token",
    client_id: c.env.GITHUB_CLIENT_ID,
    client_secret: c.env.GITHUB_CLIENT_SECRET,
    code: c.req.query("code"),
    redirect_uri: new URL("/callback", c.req.url).href,
  });
  if (errResponse) {
    console.log("RETURNING ERROR RESPONSE", errResponse);
    return errResponse;
  }
  const userInfo =
    "https://james.cloudflareaccess.com/cdn-cgi/access/sso/oidc/69e669cd8e007fd178050ccbaf6edd6a52cfda704251be2c14a26bbbd5998120/userinfo";
  const userFetch = await fetch(userInfo, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const user = (await userFetch.json()) as {
    sub: string;
    name: string;
    email: string;
  };

  //   // Fetch the user info from GitHub
  //   const user = await new Octokit({
  //     auth: accessToken,
  //   }).rest.users.getAuthenticated();
  //   const { login, name, email } = user.data;
  console.log(accessToken);
  // Return back to the MCP client a new token
  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReqInfo,
    userId: user.sub,
    metadata: {
      label: user.name,
    },
    scope: oauthReqInfo.scope,
    // This will be available on this.props inside MyMCP
    props: {
      login: user.sub,
      name: user.name,
      email: user.email,
      accessToken,
    } as Props,
  });

  return Response.redirect(redirectTo);
});

export { app as GitHubHandler };
