import './style.css'
import {answer} from './value'
const value: number = answer + 1
document.querySelector('#app')!.textContent = `vite-rolldown-ready:${value}`
