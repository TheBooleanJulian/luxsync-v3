"""tools/r2_push.py signs requests the way S3 expects (AWS's published SigV4 example)."""
import datetime
import importlib.util
import pathlib

spec = importlib.util.spec_from_file_location(
    "r2_push", pathlib.Path(__file__).resolve().parent.parent / "tools" / "r2_push.py"
)
r2_push = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r2_push)

EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"


def test_signature_matches_aws_get_object_example():
    # docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "GET Object"
    r2 = r2_push.R2({
        "R2_ACCOUNT_ID": "x",
        "R2_ACCESS_KEY_ID": "AKIAIOSFODNN7EXAMPLE",
        "R2_SECRET_ACCESS_KEY": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    })
    r2.host = "examplebucket.s3.amazonaws.com"
    headers, _ = r2._sign(
        "GET", "/test.txt", {}, {"Range": "bytes=0-9"},
        now=datetime.datetime(2013, 5, 24, tzinfo=datetime.timezone.utc),
        payload=EMPTY_SHA256, region="us-east-1",
    )
    assert headers["Authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    )
    assert "host" not in headers  # urllib sets Host itself


def test_query_string_is_sorted_and_encoded():
    r2 = r2_push.R2({"R2_ACCOUNT_ID": "a", "R2_ACCESS_KEY_ID": "k", "R2_SECRET_ACCESS_KEY": "s"})
    _, qs = r2._sign("PUT", "/b/k", {"uploadId": "a/b+c", "partNumber": "2"}, {})
    assert qs == "partNumber=2&uploadId=a%2Fb%2Bc"
    _, qs = r2._sign("POST", "/b/k", {"uploads": ""}, {})
    assert qs == "uploads="
