import { Configuration, OpenAIApi } from "openai";
import upsertPrediction from "../../../lib/upsertPrediction";
import packageData from "../../../package.json";
import fetch from "node-fetch";

import Replicate from "replicate";

const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

const REPLICATE_API_HOST = "https://api.replicate.com";
const STABILITY_API_HOST = "https://api.stability.ai";

const WEBHOOK_HOST = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : process.env.NGROK_HOST;

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});

const openai = new OpenAIApi(configuration);

export default async function handler(req, res) {
  if (!process.env.REPLICATE_API_TOKEN) {
    throw new Error(
      "The REPLICATE_API_TOKEN environment variable is not set. See README.md for instructions on how to set it."
    );
  }

  if (!WEBHOOK_HOST) {
    throw new Error(
      "WEBHOOK_HOST is not set. If you're on local, make sure you set it to an ngrok url. If this doesn't exist, replicate predictions won't save to DB."
    );
  }

  if (req.body.source == "replicate") {
    console.log("host", WEBHOOK_HOST);

    const searchParams = new URLSearchParams({
      submission_id: req.body.submission_id,
      model: req.body.model,
      anon_id: req.body.anon_id,
      source: req.body.source,
    });

    const body = {
      input: {
        prompt: req.body.prompt,
        image_dimensions: req.body.image_dimensions,
      },
      version: req.body.version,
      webhook: `${WEBHOOK_HOST}/api/replicate-webhook?${searchParams}`,
      webhook_events_filter: ["start", "completed"],
    };
    const deployment = req.body.deployment;

    const headers = {
      Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": `${packageData.name}/${packageData.version}`,
    };

    if (deployment) {
      try {
        console.log("running prediction using deployment", deployment);
        const prediction = await replicate.deployments.predictions.create(
          deployment.owner,
          deployment.name,
          body
        );

        res.statusCode = 201;
        res.end(JSON.stringify(prediction));
      } catch (err) {
        console.log("deployment-based prediction failed:", err);
      }
    } else {
      const response = await fetch(`${REPLICATE_API_HOST}/v1/predictions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (response.status !== 201) {
        let error = await response.json();
        res.statusCode = 500;
        res.end(JSON.stringify({ detail: error.detail }));
        return;
      }

      const prediction = await response.json();
      res.statusCode = 201;
      res.end(JSON.stringify(prediction));
    }
  } else if (req.body.source == "openai") {
    const response = await openai.createImage({
      prompt: req.body.prompt,
      n: 1,
      size: "512x512",
    });

    const prediction = {
      id: req.body.id,
      status: "succeeded",
      version: "dall-e",
      output: [response.data.data[0].url],
      input: { prompt: req.body.prompt },
      model: req.body.model,
      inserted_at: new Date(),
      created_at: new Date(),
      submission_id: req.body.submission_id,
      source: req.body.source,
      model: req.body.model,
      anon_id: req.body.anon_id,
    };

    upsertPrediction(prediction);

    res.statusCode = 201;
    res.end(JSON.stringify(prediction));
  } else if (req.body.source == "stability") {
    const apiKey = process.env.STABILITY_API_KEY;
    if (!apiKey) throw new Error("Missing Stability API key.");

    const engineId = "stable-diffusion-xl-beta-v2-2-2";

    const response = await fetch(
      `${STABILITY_API_HOST}/v1/generation/${engineId}/text-to-image`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          text_prompts: [
            {
              text: req.body.prompt,
            },
          ],
          cfg_scale: 7,
          clip_guidance_preset: "FAST_BLUE",
          height: 512,
          width: 512,
          samples: 1,
          steps: 30,
        }),
      }
    );

    const responseJSON = await response.json();

    if (!response.ok) {
      throw new Error(`Non-200 response: ${await response.text()}`);
    }

    console.log(
      `data is ${JSON.stringify(Object.keys(responseJSON.artifacts[0]))}`
    );

    const prediction = {
      id: req.body.id,
      status: "succeeded",
      version: "stability",
      output: [responseJSON.artifacts[0].base64],
      input: { prompt: req.body.prompt },
      model: req.body.model,
      inserted_at: new Date(),
      created_at: new Date(),
      submission_id: req.body.submission_id,
      source: req.body.source,
      model: req.body.model,
      anon_id: req.body.anon_id,
    };
    upsertPrediction(prediction);

    res.statusCode = 201;
    res.end(JSON.stringify(prediction));
  }
}
