/**
 * Entry for the browser harness: expose the platform module table's externals as
 * globals so the built artifact can be loaded exactly the way the Harness loads
 * it, in a real browser, with a real layout engine.
 *
 * The global is deliberately NOT named `__React`: esbuild's `--global-name`
 * assigns the bundle's (empty) export to that name after the IIFE runs, which
 * would overwrite whatever the entry itself put there.
 */
import * as React from "react"
import * as ReactDOM from "react-dom"
import * as ReactDOMClient from "react-dom/client"
import * as JsxRuntime from "react/jsx-runtime"

window.__DSH_EXTERNALS = { React, ReactDOM, ReactDOMClient, JsxRuntime }
