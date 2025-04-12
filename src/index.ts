import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AccessHandler } from "./access-handler.js";

// Context from the auth process, encrypted & stored in the auth token
// and provided to the DurableMCP as this.props
type Props = {
  login: string;
  name: string;
  email: string;
  accessToken: string;
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

const ALLOWED_USERNAMES = new Set(["jroyal@cloudflare.com"]);

export class MyMCP extends McpAgent<Props, Env> {
  server = new McpServer({
    name: "Access OAuth Proxy Demo",
    version: "1.0.0",
  });

  async init() {
    // Hello, world!
    this.server.tool(
      "add",
      "Add two numbers the way only MCP can",
      { a: z.number(), b: z.number() },
      async ({ a, b }) => ({
        content: [{ type: "text", text: String(a + b) }],
      })
    );

    this.server.tool(
      "echoRequest",
      "See what the request looks like on the origin",
      {},
      async ({}) => {
        console.log("running a request", this.props.access_token);
        const resp = await fetch(`https://test.almightyzero.com/anything`, {
          headers: {
            "cf-access-token": this.props.accessToken as string,
            "X-Requested-With": "XMLHttpRequest",
          },
        });
        let data = "failed to make the request";
        console.log(resp.status, JSON.stringify(resp.headers));
        if (resp.status === 200) {
          data = await resp.text();
        } else {
          data = `got an error. Status code = ${resp.status}`;
        }
        return {
          content: [{ type: "text", text: data }],
        };
      }
    );

    this.server.tool(
      "watermarkPDF",
      "Add a watermark to a pdf",
      { pdfUrl: z.string(), watermarkText: z.string() },
      async ({ pdfUrl, watermarkText }) => {
        console.log("Fetching PDF from:", pdfUrl);

        // Step 1: Fetch the PDF from the provided URL
        const pdfResponse = await fetch(pdfUrl);

        if (!pdfResponse.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Error fetching PDF. Status code = ${pdfResponse.status}`,
              },
            ],
          };
        }

        const pdfBuffer = await pdfResponse.arrayBuffer();

        // Step 2: Submit to watermarking API
        const form = new FormData();
        form.append("fileInput", new Blob([pdfBuffer]), "document.pdf");
        form.append("watermarkType", "text");
        form.append("watermarkText", watermarkText);
        form.append("fontSize", "30");
        form.append("rotation", "45");
        form.append("opacity", ".5");
        form.append("widthSpacer", "50");
        form.append("heightSpacer", "50");
        form.append("customColor", "#363d3d");
        form.append("convertPDFToImage", "false");

        const watermarkResp = await fetch(
          "https://pdf.hypersloth.io/api/v1/security/add-watermark",
          {
            method: "POST",
            body: form,
            headers: {
              "cf-access-token": this.props.accessToken as string,
              "X-Requested-With": "XMLHttpRequest",
            },
          }
        );

        if (!watermarkResp.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Error from watermark API. Status: ${watermarkResp.status}`,
              },
            ],
          };
        }

        const watermarkedPDF = await watermarkResp.arrayBuffer();
        // Step 3: Upload to share.hypersloth.io
        const uploadForm = new FormData();
        uploadForm.append(
          "file",
          new Blob([watermarkedPDF], { type: "application/pdf" }),
          "watermarked.pdf"
        );

        const uploadResp = await fetch("https://share.hypersloth.io", {
          method: "POST",
          headers: {
            // @ts-ignore
            Authorization: this.env.SHARE_UPLOAD_SECRET,
          },
          body: uploadForm,
        });

        if (!uploadResp.ok) {
          return {
            content: [
              {
                type: "text",
                text: `Error uploading to share.hypersloth.io. Status = ${uploadResp.status}`,
              },
            ],
          };
        }

        const uploadText = await uploadResp.text();

        return {
          content: [
            {
              type: "text",
              text: `PDF watermarked! Grab it here:\n\n${uploadText}`,
            },
          ],
        };
      }
    );

    // Dynamically add tools based on the user's login. In this case, I want to limit
    // access to my Image Generation tool to just me
    // @ts-ignore
    if (ALLOWED_USERNAMES.has(this.props.email)) {
      this.server.tool(
        "generateImage",
        "Generate an image using the `flux-1-schnell` model. Works best with 8 steps.",
        {
          prompt: z
            .string()
            .describe("A text description of the image you want to generate."),
          steps: z
            .number()
            .min(4)
            .max(8)
            .default(4)
            .describe(
              "The number of diffusion steps; higher values can improve quality but take longer. Must be between 4 and 8, inclusive."
            ),
        },
        async ({ prompt, steps }) => {
          // @ts-ignore
          const response = await this.env.AI.run(
            "@cf/black-forest-labs/flux-1-schnell",
            {
              prompt,
              steps,
            }
          );

          return {
            content: [
              { type: "image", data: response.image!, mimeType: "image/jpeg" },
            ],
          };
        }
      );
    }
  }
}

export default new OAuthProvider({
  apiRoute: "/sse",
  // @ts-ignore
  apiHandler: MyMCP.mount("/sse"),
  // @ts-ignore
  defaultHandler: AccessHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
