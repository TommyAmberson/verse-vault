from django.urls import include, path
from rest_framework import routers

from . import views

urlpatterns = [
    path("public", views.PublicMessageApiView.as_view(), name="public-message"),
    path("private", views.PrivateMessageApiView.as_view(), name="private-message"),
    # path("protected", ProtectedMessageApiView.as_view(), name="protected-message"),
    # path("admin", AdminMessageApiView.as_view(), name="admin-message"),
]
