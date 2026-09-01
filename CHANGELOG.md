# Calendar_Deepseek Changelog

## [Poster Recognition] - {PR_MERGE_DATE}

- Create events from event posters, not just text. The command now detects a
  screenshot, a copied image file, or a Finder selection automatically and falls
  back to clipboard text.
- Posters are read by DeepSeek's vision model together with on-device OCR from
  the macOS Vision framework, so dense small print stays legible while the image
  keeps each date attached to the right session.
- Added optional preferences for the vision model id, poster image detail, and
  turning on-device OCR off.

## [Initial Version] - {PR_MERGE_DATE}