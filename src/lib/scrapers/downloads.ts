import { load } from "cheerio";

import { curlText } from "../../utils/curl";
import { withBaseUrl } from "../utils";

export async function getFinalDownloadUrl(downloadPageUrl: string) {
  const { text } = await curlText(downloadPageUrl);
  const redirectUrl = withBaseUrl(extractRedirectDownloadUrl(text));

  const { text: downloadPageText } = await curlText(redirectUrl);
  return withBaseUrl(extractFinalDownloadUrl(downloadPageText));
}

export function extractRedirectDownloadUrl(downloadPageHtml: string) {
  const $ = load(downloadPageHtml);
  const downloadUrl = $(`a.downloadButton`).attr("href");
  if (!downloadUrl) {
    throw new Error("Could not find redirect download url");
  }
  return downloadUrl;
}

export function extractFinalDownloadUrl(downloadPageHtml: string) {
  const $ = load(downloadPageHtml);
  const downloadUrl = $(`.card-with-tabs a[href]`).attr("href");
  if (!downloadUrl) {
    throw new Error("Could not find final download url");
  }
  return downloadUrl;
}
