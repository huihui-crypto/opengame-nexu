/**
 * Global Studio sign-in context attached to `page_view`, `ui_click`, and `surface_view` events
 * when known. Kept separate from `./tracking` so unit tests that mock `./tracking` remain isolated.
 */
let currentSignedIn: boolean | undefined;

export function setMotionSignedIn(value: boolean | undefined) {
  currentSignedIn = value;
}

export function getMotionSignedIn(): boolean | undefined {
  return currentSignedIn;
}
