import SwiftUI

struct ContentView: View {
    @StateObject private var model = PlayerModel()
    @State private var query = ""

    var body: some View {
        NavigationView {
            VStack(spacing: 10) {
                HStack(spacing: 8) {
                    TextField("Search songs", text: $query)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .onSubmit { model.search(query) }
                    Button("Search") { model.search(query) }
                        .buttonStyle(.borderedProminent)
                        .disabled(model.busy || query.trimmingCharacters(in: .whitespaces).isEmpty)
                }

                if !model.hits.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(Array(model.hits.prefix(12))) { hit in
                                Button {
                                    model.pick(hit)
                                } label: {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(hit.title)
                                            .font(.subheadline.weight(.semibold))
                                            .lineLimit(1)
                                        Text(hit.artist)
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                        Text(hit.duration)
                                            .font(.caption2)
                                            .foregroundStyle(.secondary)
                                    }
                                    .frame(width: 150, alignment: .leading)
                                    .padding(8)
                                    .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 1)
                    }
                    .frame(height: 82)
                }

                HStack(spacing: 8) {
                    TextField("Video ID", text: $model.videoId)
                        .textFieldStyle(.roundedBorder)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .font(.system(.body, design: .monospaced))
                    Button("Resolve") { model.resolve() }
                        .buttonStyle(.bordered)
                        .disabled(model.busy || model.videoId.isEmpty)
                }

                HStack(spacing: 10) {
                    Button("Play") { model.play() }
                        .buttonStyle(.borderedProminent)
                    Button("Pause") { model.pause() }
                        .buttonStyle(.bordered)
                    Button("Resume") { model.resume() }
                        .buttonStyle(.bordered)
                    Spacer()
                    Toggle("HLS", isOn: $model.preferHls)
                        .toggleStyle(.switch)
                        .fixedSize()
                }

                HStack(spacing: 8) {
                    Text(model.status)
                        .font(.footnote)
                        .lineLimit(1)
                    Spacer()
                    Text(timeString(model.elapsed))
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(.secondary)
                    Button("Copy log") { model.copyLog() }
                        .buttonStyle(.bordered)
                        .font(.footnote)
                }

                ScrollView {
                    Text(model.log)
                        .font(.system(size: 11, design: .monospaced))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                        .padding(8)
                }
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
            }
            .padding()
            .navigationTitle("ytm iOS PoC")
            .navigationBarTitleDisplayMode(.inline)
        }
        .navigationViewStyle(.stack)
    }

    private func timeString(_ seconds: Double) -> String {
        guard seconds.isFinite, seconds >= 0 else { return "0:00" }
        return String(format: "%d:%02d", Int(seconds) / 60, Int(seconds) % 60)
    }
}
