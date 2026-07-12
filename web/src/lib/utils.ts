// Standard shadcn/ui `cn()` helper — merges conditional class lists (clsx)
// and then resolves conflicting Tailwind utility classes (tailwind-merge),
// so e.g. `cn("px-2", condition && "px-4")` correctly keeps only "px-4".
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
