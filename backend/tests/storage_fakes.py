"""Isolated in-memory S3 transport with the production Boto signing contract."""
from datetime import timedelta, timezone
from io import BytesIO
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, EndpointConnectionError
from botocore.response import StreamingBody

def sdk_client():
    return boto3.session.Session().client('s3', endpoint_url='https://' + 'a' * 32 + '.r2.cloudflarestorage.com',
        region_name='auto', aws_access_key_id='isolated-access', aws_secret_access_key='isolated-secret',
        config=Config(signature_version='s3v4', s3={'addressing_style': 'path'}))


class MemoryS3:
    """Simulated S3 only: production adapter, jobs, API and billing remain real."""
    def __init__(self):
        self.objects, self.calls = {}, []
        self.fail_delete = False
        self.fail_head = False
        self.uncertain_put = False
        self.generate_presigned_url = sdk_client().generate_presigned_url

    def put_object(self, **params):
        self.calls.append(('PUT', params['Key']))
        self.objects[params['Key']] = params['Body']
        assert params['ContentType'] in {'image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'}
        assert params['CacheControl'] == 'private, no-store'
        if self.uncertain_put:
            self.uncertain_put = False
            raise EndpointConnectionError(endpoint_url='secret diagnostic must not escape')
        return {}

    def head_object(self, **params):
        self.calls.append(('HEAD', params['Key']))
        if self.fail_head:
            raise EndpointConnectionError(endpoint_url='secret diagnostic must not escape')
        if params['Key'] not in self.objects:
            raise ClientError({'Error': {'Code': '404'}, 'ResponseMetadata': {'HTTPStatusCode': 404}}, 'HeadObject')
        return {}

    def get_object(self, **params):
        self.calls.append(('GET', params['Key']))
        data = self.objects[params['Key']]
        return {'Body': StreamingBody(BytesIO(data), len(data))}

    def delete_object(self, **params):
        self.calls.append(('DELETE', params['Key']))
        if self.fail_delete:
            raise EndpointConnectionError(endpoint_url='secret diagnostic must not escape')
        self.objects.pop(params['Key'], None)
        return {}

    def list_objects_v2(self, **params):
        from app.models import now
        keys = sorted(k for k in self.objects if k > params.get('ContinuationToken', ''))
        page = keys[:params['MaxKeys']]
        return {'Contents': [{'Key': k, 'LastModified': (now() - timedelta(days=2)).replace(tzinfo=timezone.utc)} for k in page],
                'IsTruncated': len(keys) > len(page), 'NextContinuationToken': page[-1] if page else None}
