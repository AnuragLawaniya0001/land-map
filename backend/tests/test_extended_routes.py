from app.extended_routes import (
    build_extended_router,
    generate_raw_token,
    hash_token,
    is_valid_indian_phone,
    validate_image_buffer,
)


def test_image_validation_checks_mime_and_magic_bytes():
    assert validate_image_buffer(b"\xff\xd8\xff" + b"\x00" * 5, "image/jpeg")
    assert validate_image_buffer(b"\x89PNG" + b"\x00" * 4, "image/png")
    assert validate_image_buffer(b"RIFF" + b"\x00" * 4 + b"WEBP", "image/webp")
    assert not validate_image_buffer(b"\x89PNG" + b"\x00" * 4, "image/jpeg")
    assert not validate_image_buffer(b"short", "image/png")
    assert not validate_image_buffer(b"\x00" * 8, "image/gif")


def test_indian_phone_validation_strips_formatting_but_checks_digit_count():
    assert is_valid_indian_phone("+91 (98765) 43210")
    assert is_valid_indian_phone("987654321012")
    assert not is_valid_indian_phone("123456789")
    assert not is_valid_indian_phone("1234567890123")
    assert not is_valid_indian_phone(9876543210)


def test_share_tokens_are_hashed_and_have_full_entropy():
    token = generate_raw_token()
    assert len(token) == 64
    assert token != hash_token(token)
    assert hash_token(token) == hash_token(token)
    assert len(hash_token(token)) == 64


def test_router_registers_routes_for_each_feature_family():
    async def dependency(*_args, **_kwargs):
        return {"id": "user", "role": "admin"}

    router = build_extended_router(
        db=object(),
        get_current_user=dependency,
        require_admin=dependency,
        require_super_admin=dependency,
        load_owned_colony=dependency,
        audit_log=dependency,
        serialize_doc=lambda doc: doc,
    )
    routes = {(route.path, method) for route in router.routes for method in route.methods}
    assert ("/admin/plots/{plot_id}/shares", "POST") in routes
    assert ("/share/{token}", "GET") in routes
    assert ("/admin/plots/{plot_id}/media", "POST") in routes
    assert ("/public/inquiries", "POST") in routes
    assert ("/public/portal/{token}/session", "POST") in routes
    assert ("/admin/plots/{plot_id}/ownership/transfer", "POST") in routes
