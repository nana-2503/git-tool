/**
 * The one rewrite a vendored file needs. Shared by the vendor step and the
 * verification step so the two can never disagree about what "the official
 * source plus our rewrites" means.
 */

/** Strip the Next directive; it is noise in a Cordis client bundle. */
function stripUseClient(source) {
  return source.replace(/^"use client"\n\n?/m, '');
}

/**
 * The installer writes sibling imports through this project's `ui` alias
 * (`vendor/ui/button`); in one flat directory they become `./button`.
 */
function flattenImports(source) {
  return source.replace(/from "vendor\/ui\//g, 'from "./');
}

/** Everything we change about an official file, and nothing else. */
export function codemod(source, name) {
  const out = flattenImports(stripUseClient(source));
  if (/"use client"|from "vendor\/ui\//.test(out)) {
    throw new Error(`${name}: codemod left something behind`);
  }
  return out;
}
