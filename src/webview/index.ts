import { mount } from 'svelte'
import type { ViewMessage } from '../host/messages.js'
import App from './App.svelte'
import './style.css'

declare function acquireVsCodeApi(): { postMessage(message: ViewMessage): void }
const vscode = acquireVsCodeApi()

mount(App, { target: document.getElementById('app')!, props: { post: message => vscode.postMessage(message) } })
