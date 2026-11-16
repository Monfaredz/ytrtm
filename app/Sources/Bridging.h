#ifndef YTM_POC_BRIDGING_H
#define YTM_POC_BRIDGING_H

// The Rust core (rust/src/lib.rs). Each call returns a C string that ytm_free()
// releases; null only for a null argument.
char *ytm_search(const char *query);
char *ytm_resolve(const char *video_id);
char *ytm_probe(const char *url);
void ytm_free(char *ptr);

#endif
