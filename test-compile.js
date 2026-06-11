"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var major = 22;
if (major < 22)
    process.exit(1);
var fs_1 = require("fs");
console.log(fs_1.default.readFileSync);
