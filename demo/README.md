# Local product demonstration

Actual browser execution, test funds only, approximately 75 seconds. Captions and storyboard accompany the recording. No adoption, deployment, audit or external-wallet claims.

Audience: bounty judges and the builder reviewing functionality. Story: published terms, contribution, atomic execution, claim, migration/trade, failure recovery. Visual direction follows the product's warm paper/charcoal palette. One product frame and one short scene label at a time; no stock imagery, music, promotional valuation or fabricated metrics.

Source: tests/demo.cjs and app/public/demo-frame.html. Start the local API and app first. Install the small recording helper with PLAYWRIGHT_BROWSERS_PATH=.cache/playwright npx playwright install ffmpeg, then run PLAYWRIGHT_BROWSERS_PATH=.cache/playwright node tests/demo.cjs. The final WebM replaces a Chrome screencast gray bottom strip outside the product frame with the matching background, using crop1600x812 then pad1600x900. No product interaction or transaction is substituted. The wrapper's scene labels are burned in; captions.srt and captions.vtt contain the same scene headings.

This is a 16:9 functional rehearsal, not the final promotional pitch. Do not use local transaction signatures as explorer evidence.
