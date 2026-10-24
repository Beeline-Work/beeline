import { useSegments } from "expo-router";
import { funnelScreenFromSegments } from "@beeline/api-contract/signin-funnel";
import { funnelScreenShown } from "@/auth/signin-funnel";
import { tracking } from "./tracking";
import React from "react";

export function useTrackScreens() {
    const segments = useSegments();
    const route = segments.filter(segment => !segment.startsWith('(')).join('/'); // Using segments before normalizing to avoid leaking any params
    const screen = funnelScreenFromSegments(segments); // Allowlisted route pattern or null; never a value
    React.useEffect(() => { tracking?.screen(route); }, [route]); // NOTE: NO PARAMS HERE - we dont want to leak anything at all, except very basic stuff
    React.useEffect(() => { if (screen) void funnelScreenShown(screen).catch(() => undefined); }, [screen]);
}
