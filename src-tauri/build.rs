fn main() {
    tauri_build::build();

    // Generate gRPC/protobuf sources only when the `grpc` feature is enabled.
    // This keeps desktop shell builds lightweight unless service mode is needed.
    if std::env::var_os("CARGO_FEATURE_GRPC").is_some() {
        let protoc = protoc_bin_vendored::protoc_bin_path()
            .expect("failed to locate vendored protoc binary");
        std::env::set_var("PROTOC", protoc);

        println!("cargo:rerun-if-changed=proto/analysis/v1/analysis.proto");
        println!("cargo:rerun-if-changed=proto/projects/v1/projects.proto");

        tonic_build::configure()
            .build_server(true)
            .build_client(true)
            .compile_protos(
                &[
                    "proto/analysis/v1/analysis.proto",
                    "proto/projects/v1/projects.proto",
                ],
                &["proto"],
            )
            .expect("failed to compile gRPC protobuf contracts");
    }
}
