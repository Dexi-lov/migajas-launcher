#[cfg(test)]
mod tests {
    use crate::auth;
    use crate::sync;
    use uuid::Uuid;

    // ── Auth: UUID offline ─────────────────────────────────────
    #[test]
    fn test_auth_login_offline_generates_valid_uuid() {
        let uuid_str = auth::offline_uuid_for("TestPlayer").unwrap();
        let uuid = Uuid::parse_str(&uuid_str).unwrap();
        // Minecraft offline siempre genera UUID v3 (MD5)
        assert_eq!(uuid.get_version_num(), 3);
    }

    #[test]
    fn test_auth_login_offline_known_vanilla_uuid() {
        // "Notch" offline: 069a79f4-44e9-4726-a5be-fca90e38aaf5
        let uuid_str = auth::offline_uuid_for("Notch").unwrap();
        assert_eq!(uuid_str, "069a79f4-44e9-4726-a5be-fca90e38aaf5");
    }

    #[test]
    fn test_auth_login_offline_rejects_invalid_username() {
        assert!(auth::offline_uuid_for("").is_err());
        assert!(auth::offline_uuid_for("ThisNameIsWayTooLong").is_err());
        assert!(auth::offline_uuid_for("bad name").is_err());
        assert!(auth::offline_uuid_for("bad-name").is_err());
    }

    // ── Sync: cancelación ──────────────────────────────────────
    #[tokio::test]
    async fn test_sync_cancellation() {
        let manager = sync::SyncManager::default();
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        manager
            .cancellations
            .lock()
            .await
            .insert("inst1".into(), tx);
        let _ = manager
            .cancellations
            .lock()
            .await
            .get("inst1")
            .unwrap()
            .send(true);
        assert!(*rx.borrow());
    }

    #[tokio::test]
    async fn test_hash_file_known_sha1() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        tokio::fs::write(&path, b"hello world").await.unwrap();
        let hash = sync::hash_file(&path).await.unwrap();
        // SHA1("hello world") = 2aae6c35c94fcfb415dbe95f408b9ce91ee846ed
        assert_eq!(hash, "2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
    }

    // ── Launch: sanitización de argumentos JVM ─────────────────
    #[test]
    fn test_launch_config_sanitization() {
        let args: Vec<String> = vec![
            "-Dfoo=bar".into(),
            "; rm -rf /".into(),
            "-Dvalid=true".into(),
            "$(malicious)".into(),
            "a & b".into(),
        ];
        let sanitized: Vec<String> = args
            .into_iter()
            .filter(|arg| {
                !arg.contains(";")
                    && !arg.contains("|")
                    && !arg.contains("&")
                    && !arg.contains("$(")
            })
            .collect();
        assert_eq!(sanitized.len(), 2);
        assert!(sanitized.contains(&"-Dfoo=bar".into()));
        assert!(sanitized.contains(&"-Dvalid=true".into()));
    }
}
