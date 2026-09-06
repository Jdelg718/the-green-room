"use strict";
const state = document.getElementById("boot-state");
if (state) state.textContent = "Bundled shell ready — no server required.";
document.documentElement.dataset.shellBoot = "contained";
