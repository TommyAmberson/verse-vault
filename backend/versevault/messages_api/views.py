from rest_framework.permissions import IsAuthenticated
from rest_framework.views import exception_handler, APIView
from rest_framework.response import Response
from rest_framework.renderers import JSONRenderer
from rest_framework import viewsets, permissions, status

from versevault.authz.permissions import HasAdminPermission
from versevault.messages_api.models import Message
from versevault.messages_api.serializers import MessageSerializer


class PublicMessageApiView(APIView):
    def get(self, request):
        print(request.auth)
        messages = Message.objects.filter(public=True)
        serializer = MessageSerializer(messages, many=True)
        return Response(serializer.data)

    def post(self, request, format=None):
        serializer = MessageSerializer(data=request.data)
        if serializer.is_valid():
            print(serializer.validated_data)
            if serializer.validated_data["public"]:
                serializer.save()
                return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


class PrivateMessageApiView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        print(request.user)
        messages = Message.objects.filter(public=False)
        serializer = MessageSerializer(messages, many=True)
        return Response(serializer.data)

    def post(self, request, format=None):
        serializer = MessageSerializer(data=request.data)
        if serializer.is_valid() and not data.public:
            serializer.save()
            return Response(serializer.data, status=status.HTTP_201_CREATED)
        return Response(serializer.errors, status=status.HTTP_400_BAD_REQUEST)


def api_exception_handler(exc, context=None):
    response = exception_handler(exc, context=context)

    # if response is None:
    #     response = Response()
    #
    # if response.status_code == 403:
    #     response.data = {
    #         "error": "insufficient_permissions",
    #         "error_description": response.data.get("detail", "API Error"),
    #         "message": "Permission denied",
    #     }
    # elif response and isinstance(response.data, dict):
    #     response.data = {"message": response.data.get("detail", "API Error")}
    # else:
    #     response.data = {"message": "API Error"}
    return response
