# Dark Screenshots for Reddit

Turns bright screenshots dark on Reddit, such as Chrome Web Store dashboard shots and payment emails.

- **Screenshots you read:** bright UI screenshots on Reddit are shown dark. By default this follows Chrome's light or dark theme, and it can be set to Always. Photos are left alone. A white page with dark panels or photos on it gets only the page darkened. A dark panel on a blurred screenshot gets the blur darkened, and a photo under a pale browser toolbar gets the toolbar darkened.
- **Screen recordings (optional, off by default):** light-mode screen recordings and software demos in Reddit's video player are shown dark too. The extension samples five frames from Reddit's small preview copy of each video, and darkens the whole video if at least four look like a bright UI. A video that mixes screen capture with real-life footage is usually left alone. A bright real-life clip, such as a white studio or snow, can be darkened by mistake. Old Reddit, embeds such as YouTube, and uploads aren't covered.
- **Screenshots you upload:** a bright screenshot chosen, pasted or dropped on Reddit is replaced with a dark copy before Reddit receives it.
- **AI check (optional, off until you pick it in the popup):** the built-in checks can't tell a drawing from an app, so an image they would darken can go to an AI model on your computer, which is asked whether it's a capture of software on a screen. If it says no, the image stays as it is. It uses Ollama or Chrome's built-in model, whichever the popup finds ready, and each image is asked once. A model works the graphics chip hard, so it works ahead instead: the built-in checks run several screens past what you're looking at, so images are dark when they arrive, and the model looks at what you're about to reach in the gaps between scrolls. It stops the moment you scroll. A page can use a short burst of model time, and after that it runs about one seventh of the time, which keeps the laptop cool. Without one, the checks work alone, and a comic or drawing on white can get darkened.
- **Wrong call:** right-click an image or video and choose "Change dark mode".

Images are analyzed on your computer, and the AI check only talks to the model on your computer. Nothing is sent anywhere.

## Install

Download this repo (Code, then Download ZIP) and unzip it, or clone it. Open `chrome://extensions`, turn on Developer mode, choose Load unpacked, and pick the folder.

## Test

`test/run.py` runs a copy of the extension on a localhost mock page in Playwright's Chromium. It needs light screenshots named `1.png` to `4.png` in `test/shots`, which isn't committed. Name sections to run only those: `python3 test/run.py video`. The sections are `detector`, `reader`, `upload`, `video` and `popup`.

## License

MIT
