import { runAppleScript } from "@raycast/utils";

/**
 * Runs the macOS Vision framework via JXA's ObjC bridge. Needs no compilation
 * step and no extra dependency, unlike a Swift helper binary.
 *
 * Observations come back in an unspecified order, so they are sorted by their
 * bounding box to restore reading order: Vision's origin is bottom-left, so
 * descending y is top-to-bottom. Boxes within SAME_LINE_TOLERANCE of each other
 * vertically count as one line and are ordered left-to-right.
 */
const OCR_SCRIPT = `
ObjC.import('Foundation');
ObjC.import('Vision');

function run(argv) {
  var url = $.NSURL.fileURLWithPath(argv[0]);
  var handler = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $());
  var request = $.VNRecognizeTextRequest.alloc.init;

  request.recognitionLevel = 0; // accurate
  request.usesLanguageCorrection = true;
  request.recognitionLanguages = $(["zh-Hans", "zh-Hant", "en-US"]);

  handler.performRequestsError($([request]), $());

  var results = request.results;
  var items = [];

  for (var i = 0; i < results.count; i++) {
    var observation = results.objectAtIndex(i);
    var candidates = observation.topCandidates(1);
    if (candidates.count === 0) continue;

    var candidate = candidates.objectAtIndex(0);
    if (candidate.confidence < 0.3) continue;

    var box = observation.boundingBox;
    items.push({
      text: ObjC.unwrap(candidate.string),
      y: box.origin.y + box.size.height / 2,
      x: box.origin.x,
    });
  }

  items.sort(function (a, b) {
    return Math.abs(a.y - b.y) > 0.02 ? b.y - a.y : a.x - b.x;
  });

  return items
    .map(function (item) {
      return item.text;
    })
    .join("\\n");
}
`;

/**
 * Extracts text from an image with on-device OCR.
 *
 * Never throws: OCR only augments the vision model, so any failure degrades to
 * sending the image alone rather than blocking the whole flow.
 */
export async function ocrImage(imagePath: string): Promise<string> {
  try {
    const text = await runAppleScript(OCR_SCRIPT, [imagePath], {
      language: "JavaScript",
      timeout: 30_000,
    });

    return text.trim();
  } catch (error) {
    console.debug("Local OCR failed, falling back to image-only:", error);
    return "";
  }
}
