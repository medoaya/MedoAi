import { useState, useEffect } from "react";
import Prediction from "../components/prediction";
import Popup from "../components/popup";
import ZooHead from "../components/zoo-head";
import ExternalLink from "../components/external-link";
import promptmaker from "promptmaker";
import Link from "next/link";
import { v4 as uuidv4 } from "uuid";
import { useRouter } from "next/router";
import Pills from "../components/pills";

const HOST = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000";

import seeds from "../lib/seeds.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function Home({ baseUrl, submissionPredictions, availableModels }) {
  const router = useRouter();
  const { id } = router.query;
  const [prompt, setPrompt] = useState("");
  const [predictions, setPredictions] = useState([]);
  const [error, setError] = useState(null);
  const [numOutputs, setNumOutputs] = useState(3);
  const [firstTime, setFirstTime] = useState(false);
  const [models, setModels] = useState([]);
  const [anonId, setAnonId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [numRuns, setNumRuns] = useState(1);
  const [popupOpen, setPopupOpen] = useState(false);

  async function getPredictionsFromSeed(seed) {
    const response = await fetch(`/api/submissions/${seed}`, {
      method: "GET",
    });
    submissionPredictions = await response.json();
    setPredictions(submissionPredictions);

    // get the model names from the predictions, and update which ones are checked
    const modelNames = getModelsFromPredictions(submissionPredictions);
    updateCheckedModels(modelNames);

    // get the prompt from the predictions, and update the prompt
    const submissionPrompt = getPromptFromPredictions(submissionPredictions);
    setPrompt(submissionPrompt);
    setLoading(false);
  }

  function getPromptFromPredictions(predictions) {
    if (predictions.length == 0) {
      return "";
    }
    return predictions[0].input.prompt;
  }

  function getModelsFromPredictions(predictions) {
    return predictions.map((p) => p.model);
  }

  function predictionsStillRunning(predictions) {
    return predictions.some((p) => p.status != "succeeded");
  }

  const updateCheckedModels = (modelNames) => {
    // Create a new array where each model's `checked` value is updated
    const updatedModels = availableModels.map((model) => {
      // If the model's name is in the list of names, set `checked` to true, else set it to false
      return {
        ...model,
        checked: modelNames.includes(model.name),
      };
    });

    // Update the state with the new array
    setModels(updatedModels);
  };

  function getSelectedModels() {
    return models.filter((m) => m.checked);
  }

  function getPredictionsByVersion(version) {
    return predictions.filter((p) => p.version === version);
  }

  const handleCheckboxChange = (e) => {
    const modelId = parseInt(e.target.value, 10);

    // Update the checked flag for the model with the matching modelId
    const updatedModels = models.map((model) => {
      if (model.id === modelId) {
        return {
          ...model,
          checked: e.target.checked,
        };
      }
      return model;
    });

    // Set the new models array
    setModels(updatedModels);

    // save to local storage
    localStorage.setItem("models", JSON.stringify(updatedModels));
  };

  // cmd + enter to submit
  const onKeyDown = (e) => {
    if (e.metaKey && e.which === 13) {
      handleSubmit(e, prompt);
    }
  };

  function ogParams() {
    return new URLSearchParams({
      done: !predictionsStillRunning(predictions),
      prompt: getPromptFromPredictions(submissionPredictions),
      ids: submissionPredictions.map((prediction) => prediction.id).join(","),
    });
  }

  async function postPrediction(prompt, model, submissionId) {
    model.default_params.width = 1024
    model.default_params.height = 1024
    model.default_params.num_outputs = 1
    return fetch("/api/predictions/sdxlfinetunes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt_raw: prompt,
        prompt_template: model.prompt_template,
        prompt_example: model.prompt_example,
        version: model.version,
        source: model.source,
        model: model.name,
        default_params: model.default_params,
        anon_id: anonId,
        submission_id: submissionId,
        ...(model.source != "replicate" && { id: uuidv4() }),
        ...(model.source != "replicate" && {
          created_at: new Date().toISOString(),
        }),
      }),
    });
  }

  async function createReplicatePrediction(prompt, model, submissionId) {
    const response = await postPrediction(prompt, model, submissionId);
    let prediction = await response.json();

    if (response.status !== 201) {
      throw new Error(prediction.detail);
    }

    while (
      prediction.status !== "succeeded" &&
      prediction.status !== "failed"
    ) {
      await sleep(500);
      const response = await fetch("/api/predictions/" + prediction.id);
      prediction = await response.json();
      console.log(prediction);
      if (response.status !== 200) {
        throw new Error(prediction.detail);
      }
    }

    prediction.model = model.name;
    prediction.source = model.source;

    return prediction;
  }

  async function createDallePrediction(prompt, model, submissionId) {
    const response = await postPrediction(prompt, model, submissionId);

    let prediction = await response.json();
    prediction.source = model.source;
    prediction.version = model.version;

    return prediction;
  }

  const handleSubmit = async (e, prompt) => {
    e.preventDefault();
    setError(null);
    setFirstTime(false);

    // update num runs and save to local storage
    const newNumRuns = Number(numRuns) + 1;
    setNumRuns(newNumRuns);
    localStorage.setItem("numRuns", newNumRuns);

    const hasClosedPopup = localStorage.getItem("hasClosedPopup");

    if (!hasClosedPopup && newNumRuns != 0 && newNumRuns % 10 == 0) {
      setPopupOpen(true);
    }

    const submissionId = uuidv4();

    for (const model of getSelectedModels()) {
      // Use the model variable to generate predictions with the selected model
      for (let i = 0; i < numOutputs; i++) {
        let promise = null;

        if (model.source == "replicate") {
          promise = createReplicatePrediction(prompt, model, submissionId);
        } else if (model.source == "openai") {
          promise = createDallePrediction(prompt, model, submissionId);
        } else if (model.source == "stability") {
          promise = createDallePrediction(prompt, model, submissionId);
        }

        promise.model = model.name;
        promise.source = model.source;
        promise.version = model.version;

        setPredictions((prev) => [...prev, promise]);

        promise
          .then((result) => {
            setPredictions((prev) =>
              prev.map((x) => (x === promise ? result : x))
            );
          })
          .catch((error) => setError(error.message));
      }
    }

    // push router to new page
    router.query.id = submissionId;
    router.push(router);
  };

  function checkOrder(list1, list2) {
    // Check if both lists are of the same length
    if (list1.length !== list2.length) {
      return false;
    }

    // Check if names are in the same order
    for (let i = 0; i < list1.length; i++) {
      if (list1[i].name !== list2[i].name) {
        return false;
      }
    }

    // If we made it here, the names are in the same order
    return true;
  }

  useEffect(() => {
    console.log(
      submissionPredictions.map((prediction) => prediction.id).join(",")
    );
    const anonId = localStorage.getItem("anonId");
    const storedModels = localStorage.getItem("models");
    setLoading(true);

    // if the page has an id set
    if (id) {
      setPredictions(submissionPredictions);

      // get the model names from the predictions, and update which ones are checked
      const modelNames = getModelsFromPredictions(submissionPredictions);
      updateCheckedModels(modelNames);

      // get the prompt from the predictions, and update the prompt
      const submissionPrompt = getPromptFromPredictions(submissionPredictions);
      setPrompt(submissionPrompt);

      setLoading(false);
    } else {
      // load random seed
      if (router.isReady) {
        const seed = seeds[Math.floor(Math.random() * seeds.length)];

        getPredictionsFromSeed(seed);
        router.query.id = seed;
        router.push(router);
      }
    }

    // get number of runs from local storage
    const storedNumRuns = localStorage.getItem("numRuns");
    if (storedNumRuns) {
      setNumRuns(storedNumRuns);
    } else {
      localStorage.setItem("numRuns", numRuns);
    }

    // setup id
    if (!anonId) {
      const uuid = uuidv4();
      localStorage.setItem("anonId", uuid);
      setAnonId(uuid);
      setFirstTime(true);
    } else {
      console.log("returning user: ", anonId);
      setAnonId(anonId);
    }
  }, []);

  console.log("predictions: ", predictions);

  return (
    <div className="mx-auto container p-5">
      {/* Header */}
      <ZooHead
        ogDescription={
          submissionPredictions && submissionPredictions.length > 0
            ? getPromptFromPredictions(submissionPredictions)
            : "Compare text-to-image models like Stable Diffusion and DALL-E"
        }
        ogImage={`${baseUrl}/api/og?${ogParams()}`}
      />

      {/* Tabs */}
      <Popup open={popupOpen} setOpen={setPopupOpen} />
      <Pills />

      {/* Welcome message */}
      <div className="pt-4">
        <div className="mx-0 max-w-7xl">
          <div className="flex justify-between mx-0">
            <div>
              {firstTime && (
                <span className="text-2xl font-medium tracking-tight text-gray-500">
                  Welcome to the Zoo, a playground for text to image models.{" "}
                </span>
              )}
              <span className="text-2xl font-medium tracking-tight text-gray-900">
                What do you want to see?
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Prompt input */}
      <div className="h-24">
        <form
          onKeyDown={onKeyDown}
          className="w-full"
          onSubmit={(e) => handleSubmit(e, prompt)}
        >
          <div className="flex relative mt-2">
            {" "}
            <div className="w-full h-full relative">
              <textarea
                name="prompt"
                className="w-full border-2 p-3 pr-12 text-sm md:text-base rounded-md ring-brand outline-brand"
                rows="2"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Enter a prompt to display an image"
              />

              <button
                className="absolute right-3.5 top-2 text-gray-500 hover:text-gray-900 px-1 py-2 rounded-md flex justify-center items-center"
                type="button"
                onClick={() => setPrompt(promptmaker({ flavors: null }))}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={1.5}
                  stroke="currentColor"
                  className="w-5 h-5"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"
                  />
                </svg>
              </button>
            </div>
            <div className="ml-3 mb-1.5 inline-flex">
              <button
                className="button bg-brand h-full flex justify-center items-center font-bold hover:bg-orange-600"
                type="submit"
              >
                Go{" "}
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Loading message */}
      {loading && "Loading..."}

      {/* Model selector */}
      <div className={``}>
        <h5 className="text-lg text-gray-800 font-bold">SDXL Fine-Tunes</h5>
        <div className="mt-2 pb-2 flex space-x-3 w-full overflow-x-scroll">
          {models.map((model) => (
            <div key={model.id} className="w-40 shrink-0">
              <div className="relative flex items-center h-7">
                <input
                  className="h-4 w-4 rounded accent-brand border-gray-300 focus:ring-indigo-600"
                  type="checkbox"
                  id={`model_input_${model.id}`}
                  value={model.id}
                  checked={model.checked}
                  onChange={handleCheckboxChange}
                />
                <div className="ml-3 text-xs md:text-sm leading-6">
                  <label
                    htmlFor={`model_input_${model.id}`}
                    className={"" + (model.checked ? "text-gray-900" : "text-gray-500")}
                  >
                    <div>{model.name}</div>
                  </label>
                </div>
              </div>
              <div>
                <label htmlFor={`model_input_${model.id}`}>
                  <img src={model.cover_image_url} className=""></img>
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Outputs */}
      <div className="mt-8">
        {/* <h5 className="text-lg text-gray-800 font-bold">Model Outputs</h5> */}
        {!loading && getSelectedModels().length == 0 && <EmptyState />}

        {getSelectedModels().map((model) => (
          <div key={model.id} className="mt-5">
            <div className="flex gap-6 tracking-wide mb-10">
              {/* Model description */}
              <div className="w-72 border-l-4 border-gray-900 pl-5 md:pl-6 py-2">
                <Link
                  href={`https://replicate.com/${model.owner.toLowerCase()}?utm_source=project&utm_campaign=zoo`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <h5 className="text-xs md:text-sm text-gray-500 hover:text-gray-900">
                    {model.owner}
                  </h5>
                </Link>
                <Link
                  href={model.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <h5 className="text-base md:text-xl font-medium text-gray-800 hover:text-gray-500">
                    {model.name}
                  </h5>
                </Link>
                <p className="text-xs md:text-sm text-gray-500 mt-2 md:mt-4">
                  {model.description}
                </p>

                <div className="mt-2 md:mt-6 flex gap-2">
                  {model.links != null &&
                    model.links.map((link) => (
                      <ExternalLink
                        key={`${model.id}-${link.url}`}
                        link={link}
                      />
                    ))}
                </div>
              </div>

              {/* Row for predictions */}
              <div className="flex w-full overflow-y-hidden overflow-x-auto space-x-6">
                {getPredictionsByVersion(model.version)
                  .reverse()
                  .map((prediction) => (
                    <>
                      <Prediction
                        key={prediction.id}
                        prediction={prediction}
                        height={"52"}
                        width={"52"}
                      />
                    </>
                  ))}
              </div>
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}


export function EmptyState() {
  return (
    <div className="text-center mt-16">
      <img
        alt="confused robot"
        className="mx-auto rounded-lg"
        src="./confused_bot.png"
      />
      <h3 className="mt-6 text-sm font-semibold text-gray-900">
        No model selected!
      </h3>
      <p className="mt-1 text-sm text-gray-500">Select a fine-tune above.</p>
    </div>
  );
}
export function EmptyStateHistory() {
  return (
    <div className="text-center mt-16">
      <img
        alt="confused robot"
        className="mx-auto rounded-lg"
        src="./confused_bot.png"
      />
      <h3 className="mt-12 text-sm font-semibold text-gray-900">
        No memories yet!
      </h3>
      <p className="mt-1 text-sm text-gray-500">Create some images first.</p>
    </div>
  );
}

// Use getServerSideProps to force Next.js to render the page on the server,
// so the OpenGraph meta tags will have the proper URL at render time.
export async function getServerSideProps({ req }) {
  // Hack to get the protocol and host from headers:
  // https://github.com/vercel/next.js/discussions/44527
  const protocol = req.headers.referer?.split("://")[0] || "http";
  const submissionId = req.url.split("?id=")[1];
  const baseUrl = `${protocol}://${req.headers.host}`;

  let submissionPredictions = [];
  console.log(`submissionId: ${submissionId}`);

  const availableModelsResponse = await fetch(`${baseUrl}/api/sdxlfinetunes`);
  const availableModels = await availableModelsResponse.json();

  if (submissionId) {
    const response = await fetch(`${baseUrl}/api/submissions/${submissionId}`, {
      method: "GET",
    });
    submissionPredictions = await response.json();
  }

  return { props: { baseUrl, submissionPredictions, availableModels } };
}
