// The two DOM helpers every panel module needs: the element with an id, and one built in a line. The build ships
// extension/src as it is, so this file must stay import-free.
export const $ = (id) => document.getElementById(id);

export const element = (tag, props = {}) => Object.assign(document.createElement(tag), props);
