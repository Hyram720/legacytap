# LegacyTap

LegacyTap builds video follow-up cards for final expense agents. The dashboard keeps simulated leads and automations separate from activity on published cards.

## Run and test

- Run `npm ci`, then `npm test` on Node.js 22 or later.
- Run `netlify dev` with the Netlify CLI to serve the dashboard, recipient route, and functions together. Set `LEGACYTAP_PUBLISH_KEY` to a unique, strong passphrase in the local process environment for local testing.
- To enable real publishing after review, configure `LEGACYTAP_PUBLISH_KEY` as a Functions secret in the intended Netlify context. Never commit the value. Without it, the server rejects card creation.
- Deploy previews use deploy-scoped storage. A production release uses site-scoped storage so recipient links survive deploys.

## Publish a card

Choose a template, record or upload an MP4 or WebM of up to 3 MB, and save the card. Add a public headline and an accurate transcript, then enter the publishing passphrase. Copy one recipient link per prospect and send it manually through a channel you are allowed to use. Anyone with the link can watch. Keep personal information, health information, and policy details out of the public card.

The callback queue tracks video playback starts per browser tab session and one callback request per card. Refresh to update the queue, then mark a request complete after you make the call. Revoke a card from its share panel to remove the hosted content. Save your work in the same browser profile. The current pilot keeps owner access in that browser and does not handle account recovery, team seats, or cross-device agent access. If the browser data is cleared, contact the site operator to revoke any remaining links. Recipient links do not expire automatically.

For testing, use synthetic scripts and video. Do not enter contact details or submit actual messages from the demo.
