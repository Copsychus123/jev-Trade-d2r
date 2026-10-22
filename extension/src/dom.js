// The DOM helpers every panel module needs: the element with an id, one built in a line, and the form controls' shared
// "answered" reset. The build ships extension/src as it is, so this file must stay import-free.
export const $ = (id) => document.getElementById(id);

export const element = (tag, props = {}) => Object.assign(document.createElement(tag), props);

/** The capture mark is a question the player has not answered yet; editing the control answers it, so the mark goes. */
export function clearCaptureMark(control) {
  control.classList.remove("from-capture", "from-learned");
  control.removeAttribute("title");
}
