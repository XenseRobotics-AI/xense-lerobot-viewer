"use client";

// The active local route must own the error boundary; importing EpisodeViewer
// from the legacy route directory does not inherit that directory's boundary.
export { default } from "@/app/[org]/[dataset]/[episode]/error";
