// Los módulos crean su logger al importarse, antes de que corra cualquier hook,
// así que el nivel hay que fijarlo aquí: bunfig.toml lo precarga.
process.env.LOG_LEVEL ??= "fatal";
